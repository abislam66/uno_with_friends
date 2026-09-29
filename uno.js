'use strict';
// UNO rules and game state. No networking or timers here: server.js handles those.

const crypto = require('crypto');

const COLORS = ['red', 'yellow', 'green', 'blue'];
const HAND_SIZE = 7;
const MAX_PLAYERS = 8;
const UNO_WINDOW_MS = 4000;          // how long others can "Catch!" someone who forgot to call UNO
const LOBBY_DROP_MS = 30000;         // in the lobby, players who close the tab are removed after this
const STAND_IN_MS = 60000;           // in a game, a computer plays for anyone gone this long (until they rejoin)
const TIMER_CHOICES = [0, 10, 15, 20, 30];
// First to this many points wins the game. Chosen with simulate.js so an average game lasts
// 10-15 min with 2 players, and each extra player adds 3-5 min. Re-run `npm run simulate` after changing.
const GAME_TARGETS = { 2: 100, 3: 180, 4: 245, 5: 310, 6: 375, 7: 445, 8: 520 };
const goalMinutes = n => [10 + 3 * (n - 2), 15 + 5 * (n - 2)];
function goalFor(players) {
  const n = Math.min(MAX_PLAYERS, Math.max(2, players));
  return { target: GAME_TARGETS[n], minutes: goalMinutes(n) };
}
const BOT_NAMES = ['Robo Rita', 'Captain Card', 'Beep Boop', 'Sir Shuffle', 'Wild Wendy', 'Turbo Tim', 'Lucky Lu', 'Professor Plus'];
const BOT_AVATARS = ['🤖', '👾', '🦾', '🛸', '🎲', '🧠', '🐙', '🦉'];

const isNumber = c => /^\d$/.test(c.value);
const isDraw = c => c.value === 'draw2' || c.value === 'wild4';
const points = c => (isNumber(c) ? Number(c.value) : c.color === 'wild' ? 50 : 20);
const mod = (a, n) => ((a % n) + n) % n;
const newId = () => 'p' + crypto.randomBytes(5).toString('hex');

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeDeck(round) {
  const deck = [];
  let n = 0;
  const add = (color, value) => deck.push({ id: `r${round}c${n++}`, color, value });
  for (const color of COLORS) {
    add(color, '0');
    for (let copy = 0; copy < 2; copy++) {
      for (let v = 1; v <= 9; v++) add(color, String(v));
      add(color, 'skip');
      add(color, 'reverse');
      add(color, 'draw2');
    }
  }
  for (let i = 0; i < 4; i++) {
    add('wild', 'wild');
    add('wild', 'wild4');
  }
  return shuffle(deck); // 108 cards
}

class Room {
  constructor(code) {
    this.code = code;
    this.players = [];
    this.hostId = null;
    this.status = 'lobby'; // lobby | playing | roundOver
    this.settings = { stacking: true, turnSeconds: 20, endless: false };
    this.round = 0;
    this.target = null; // points needed to win this game (null = no limit), fixed when the game starts
    this.gameNo = 0;
    this.events = [];
    this.eventSeq = 0;
    this.resetTable();
  }

  resetTable() {
    this.deck = [];
    this.discard = [];
    this.color = null;
    this.turn = 0;
    this.direction = 1;
    this.turnSeq = 0;
    this.turnStarted = 0;
    this.turnDeadline = null;
    this.pendingDraw = 0;      // stacked +2/+4 waiting for the current player
    this.pendingType = null;   // 'draw2' | 'wild4'
    this.drawnCardId = null;   // card just drawn that the player may still play
    this.unoVulnerable = null; // { pid, until }
    this.result = null;
  }

  event(type, data = {}) {
    this.events.push({ id: ++this.eventSeq, type, ...data });
    if (this.events.length > 40) this.events.shift();
  }

  // ---- players ----
  player(id) { return this.players.find(p => p.id === id); }
  byToken(token) { return token ? this.players.find(p => p.token === token) : undefined; }
  humans() { return this.players.filter(p => !p.bot); }
  current() { return this.players[this.turn]; }
  peek(n) { return this.players[mod(this.turn + this.direction * n, this.players.length)]; }
  top() { return this.discard[this.discard.length - 1]; }

  addPlayer({ name, avatar, bot = false }) {
    const p = {
      id: newId(),
      token: bot ? null : crypto.randomBytes(16).toString('hex'),
      name, avatar, bot,
      connected: bot,
      goneSince: null,   // when a person's last connection closed
      autoBot: false,    // a computer is standing in until this person rejoins
      hand: [], score: 0, calledUno: false,
    };
    this.players.push(p);
    if (!this.hostId && !bot) this.hostId = p.id;
    this.event('join', { pid: p.id, name });
    return p;
  }

  addBot() {
    const used = new Set(this.players.map(p => p.name));
    const i = Math.max(0, BOT_NAMES.findIndex(n => !used.has(n)));
    return this.addPlayer({ name: BOT_NAMES[i], avatar: BOT_AVATARS[i], bot: true });
  }

  removePlayer(id) {
    const i = this.players.findIndex(p => p.id === id);
    if (i < 0) return;
    const [p] = this.players.splice(i, 1);
    this.event('leave', { name: p.name });
    if (this.hostId === id) this.passHost();
  }

  // Mid-round a leaving player is replaced by a bot so the round can finish.
  replaceWithBot(p) {
    p.bot = true;
    p.autoBot = false;
    p.token = null;
    p.connected = true;
    p.goneSince = null;
    this.event('leave', { name: p.name, bot: true });
    if (this.hostId === p.id) this.passHost();
  }

  passHost() {
    const h = this.humans().find(p => p.connected) || this.humans()[0];
    this.hostId = h ? h.id : null;
  }

  // ---- closing the browser and coming back ----
  disconnect(p) {
    if (p.bot) return;
    p.connected = false;
    p.goneSince = Date.now();
  }

  reconnect(p) {
    if (p.autoBot) {
      p.bot = false;
      p.autoBot = false;
      this.event('back', { pid: p.id, name: p.name });
    }
    p.connected = true;
    p.goneSince = null;
    if (!this.player(this.hostId) || this.player(this.hostId).bot) this.hostId = p.id;
  }

  // Lobby: drop people who left. Game: let a computer stand in for them. Returns true if anything changed.
  sweepAway(now = Date.now()) {
    let changed = false;
    for (const p of [...this.players]) {
      if (p.connected || !p.goneSince) continue;
      const gone = now - p.goneSince;
      if (this.status === 'lobby') {
        if (gone > LOBBY_DROP_MS) {
          this.removePlayer(p.id);
          changed = true;
        }
      } else if (!p.bot && gone > STAND_IN_MS) {
        p.bot = true;
        p.autoBot = true;
        this.event('standIn', { pid: p.id, name: p.name });
        if (this.hostId === p.id) this.passHost();
        changed = true;
      }
    }
    return changed;
  }

  // Fresh turn clock, used when people come back to a room that was paused with nobody in it.
  restartTurnTimer() {
    if (this.status !== 'playing' || !this.settings.turnSeconds) return;
    this.turnStarted = Date.now();
    this.turnDeadline = this.turnStarted + this.settings.turnSeconds * 1000;
  }

  // ---- actions: return an error message, or null when it worked ----
  act(p, a) {
    const host = p.id === this.hostId;
    switch (a.type) {
      case 'addBot':
        if (!host) return 'Only the host can add players.';
        if (this.status === 'playing') return 'Wait until the round ends.';
        if (this.players.length >= MAX_PLAYERS) return `The room is full (${MAX_PLAYERS} players).`;
        this.addBot();
        return null;
      case 'kick': {
        const t = this.player(a.target);
        if (!host) return 'Only the host can remove players.';
        if (this.status === 'playing') return 'Wait until the round ends.';
        if (!t || t === p) return 'That player is not here.';
        this.removePlayer(t.id);
        return null;
      }
      case 'settings':
        if (!host) return 'Only the host can change the rules.';
        if (this.status === 'playing') return 'Wait until the round ends.';
        if (typeof a.stacking === 'boolean') this.settings.stacking = a.stacking;
        if (TIMER_CHOICES.includes(Number(a.turnSeconds))) this.settings.turnSeconds = Number(a.turnSeconds);
        if (typeof a.endless === 'boolean') this.settings.endless = a.endless;
        return null;
      case 'start':
      case 'next':
        if (!host) return 'Only the host can start.';
        if (this.status === 'playing') return 'A round is already going.';
        if (this.players.length < 2) return 'You need at least 2 players. Add a computer player or invite a friend.';
        if (this.status === 'lobby' || (this.result && this.result.gameOver)) this.newGame();
        this.newRound();
        return null;
      case 'lobby':
        if (!host) return 'Only the host can do that.';
        if (this.status !== 'roundOver') return 'Finish the round first.';
        this.status = 'lobby';
        this.round = 0;
        this.target = null;
        this.resetTable();
        for (const q of this.players) { q.hand = []; q.score = 0; q.calledUno = false; }
        return null;
      case 'play': return this.play(p, a.cardId, a.color);
      case 'draw': return this.draw(p);
      case 'pass': return this.pass(p);
      case 'uno': return this.callUno(p);
      case 'catch': return this.catchUno(p, a.target);
      default: return 'Unknown action.';
    }
  }

  // Scores back to 0; the target depends on how many are playing.
  newGame() {
    this.gameNo++;
    this.round = 0;
    for (const p of this.players) p.score = 0;
    this.target = this.settings.endless ? null : GAME_TARGETS[this.players.length];
  }

  newRound() {
    this.round++;
    this.resetTable();
    this.deck = makeDeck(this.round);
    for (const p of this.players) { p.hand = []; p.calledUno = false; }
    for (let i = 0; i < HAND_SIZE; i++) for (const p of this.players) p.hand.push(this.deck.pop());
    // Start on a plain number card so the first player isn't hit by an action.
    let i = this.deck.length - 1;
    while (!isNumber(this.deck[i])) i--;
    this.discard = this.deck.splice(i, 1);
    this.color = this.discard[0].color;
    this.status = 'playing';
    // A different player starts each round.
    this.turn = mod(this.round - 2, this.players.length);
    this.advance(1);
    this.event('start', { round: this.round, pid: this.current().id });
  }

  turnCheck(p) {
    if (this.status !== 'playing') return 'The round is not running.';
    if (this.current() !== p) return 'Wait for your turn.';
    return null;
  }

  matches(card) {
    if (card.color === 'wild') return true;
    return card.color === this.color || card.value === this.top().value;
  }

  canPlay(card) {
    if (this.pendingDraw > 0) {
      // Stacking: answer a +2 with a +2 or +4, answer a +4 with a +4.
      return this.pendingType === 'draw2' ? isDraw(card) : card.value === 'wild4';
    }
    if (this.drawnCardId && card.id !== this.drawnCardId) return false;
    return this.matches(card);
  }

  playableIds(p) {
    if (this.status !== 'playing' || this.current() !== p) return [];
    return p.hand.filter(c => this.canPlay(c)).map(c => c.id);
  }

  play(p, cardId, chosen) {
    const e = this.turnCheck(p);
    if (e) return e;
    const i = p.hand.findIndex(c => c.id === cardId);
    if (i < 0) return "You don't have that card.";
    const card = p.hand[i];
    if (!this.canPlay(card)) {
      return this.pendingDraw ? `Only a +2 or +4 can stack. Otherwise take ${this.pendingDraw} cards.` : "That card doesn't match. Try another one.";
    }
    if (card.color === 'wild' && !COLORS.includes(chosen)) return 'Pick a color first.';

    p.hand.splice(i, 1);
    this.discard.push(card);
    this.color = card.color === 'wild' ? chosen : card.color;
    this.drawnCardId = null;
    this.event('play', { pid: p.id, card, color: this.color });
    if (p.hand.length === 1 && !p.calledUno) this.unoVulnerable = { pid: p.id, until: Date.now() + UNO_WINDOW_MS };

    const amount = card.value === 'draw2' ? 2 : 4;
    if (p.hand.length === 0) {
      // A final +2/+4 still counts: the next player draws before points are added up.
      if (isDraw(card)) {
        const victim = this.peek(1);
        const n = this.pendingDraw + amount;
        this.giveCards(victim, n);
        this.event('draw', { pid: victim.id, count: n, forced: true });
      }
      this.endRound(p);
      return null;
    }

    if (card.value === 'skip') {
      this.event('skip', { pid: this.peek(1).id });
      this.advance(2);
    } else if (card.value === 'reverse') {
      if (this.players.length === 2) {
        // With two players, Reverse works like Skip.
        this.event('reverse', { direction: this.direction, again: p.id });
        this.advance(2);
      } else {
        this.direction *= -1;
        this.event('reverse', { direction: this.direction });
        this.advance(1);
      }
    } else if (isDraw(card)) {
      if (this.settings.stacking) {
        this.pendingDraw += amount;
        this.pendingType = card.value;
        this.advance(1);
        this.event('stack', { pid: this.current().id, total: this.pendingDraw });
      } else {
        const victim = this.peek(1);
        this.giveCards(victim, amount);
        this.event('draw', { pid: victim.id, count: amount, forced: true });
        this.advance(2);
      }
    } else {
      this.advance(1);
    }
    return null;
  }

  draw(p) {
    const e = this.turnCheck(p);
    if (e) return e;
    if (this.drawnCardId) return 'You already drew. Play that card or pass.';
    if (this.pendingDraw > 0) {
      const n = this.pendingDraw;
      this.pendingDraw = 0;
      this.pendingType = null;
      const got = this.giveCards(p, n);
      this.event('draw', { pid: p.id, count: got.length, forced: true });
      this.advance(1);
      return null;
    }
    const [card] = this.giveCards(p, 1);
    this.event('draw', { pid: p.id, count: card ? 1 : 0 });
    if (card && this.matches(card)) {
      this.drawnCardId = card.id;
      if (this.settings.turnSeconds) {
        this.turnStarted = Date.now();
        this.turnDeadline = this.turnStarted + Math.min(this.settings.turnSeconds, 10) * 1000;
      }
    } else {
      this.advance(1);
    }
    return null;
  }

  pass(p) {
    const e = this.turnCheck(p);
    if (e) return e;
    if (!this.drawnCardId) return 'You can only pass after you draw.';
    this.event('pass', { pid: p.id });
    this.advance(1);
    return null;
  }

  // Moves the server makes for a player: no playable card, time ran out, or away.
  autoMove(p, reason) {
    if (this.status !== 'playing' || this.current() !== p) return;
    this.event('auto', { pid: p.id, reason, stack: this.pendingDraw });
    if (this.drawnCardId) return this.pass(p);
    const stacked = this.pendingDraw > 0;
    this.draw(p);
    // When time runs out, the turn ends even if the drawn card could be played.
    if (!stacked && reason === 'timeout' && this.drawnCardId && this.current() === p) this.pass(p);
  }

  callUno(p) {
    if (this.status !== 'playing') return 'No round is running.';
    if (p.hand.length > 2) return 'Call UNO when you have 2 cards or fewer.';
    if (p.calledUno) return null;
    p.calledUno = true;
    if (this.unoVulnerable && this.unoVulnerable.pid === p.id) this.unoVulnerable = null;
    this.event('uno', { pid: p.id });
    return null;
  }

  catchUno(p, targetId) {
    const t = this.player(targetId);
    const v = this.unoVulnerable;
    if (this.status !== 'playing' || !t || t === p || !v || v.pid !== t.id || Date.now() > v.until) return 'Too late, nothing to catch.';
    this.unoVulnerable = null;
    this.giveCards(t, 2);
    this.event('caught', { pid: p.id, target: t.id });
    return null;
  }

  giveCards(p, n) {
    const got = [];
    for (let i = 0; i < n; i++) {
      if (!this.deck.length) this.refill();
      if (!this.deck.length) break;
      const c = this.deck.pop();
      p.hand.push(c);
      got.push(c);
    }
    if (p.hand.length > 1) {
      p.calledUno = false;
      if (this.unoVulnerable && this.unoVulnerable.pid === p.id) this.unoVulnerable = null;
    }
    return got;
  }

  refill() {
    if (this.discard.length < 2) return;
    const top = this.discard.pop();
    this.deck = shuffle(this.discard);
    this.discard = [top];
    this.event('reshuffle');
  }

  advance(n) {
    this.turn = mod(this.turn + this.direction * n, this.players.length);
    this.drawnCardId = null;
    this.turnSeq++;
    this.turnStarted = Date.now();
    this.turnDeadline = this.settings.turnSeconds ? this.turnStarted + this.settings.turnSeconds * 1000 : null;
  }

  endRound(w) {
    const hands = {};
    let pts = 0;
    for (const p of this.players) {
      if (p === w) continue;
      hands[p.id] = p.hand.slice();
      pts += p.hand.reduce((s, c) => s + points(c), 0);
    }
    w.score += pts;
    const gameOver = this.target != null && w.score >= this.target;
    this.status = 'roundOver';
    this.pendingDraw = 0;
    this.pendingType = null;
    this.turnDeadline = null;
    this.unoVulnerable = null;
    this.result = { winnerId: w.id, points: pts, hands, gameOver };
    this.event('win', { pid: w.id, points: pts, gameOver });
  }

  // ---- computer players ----
  botMoves(p) {
    if (this.status !== 'playing' || this.current() !== p) return [];
    const playable = p.hand.filter(c => this.canPlay(c));
    if (!playable.length) return [{ type: this.drawnCardId ? 'pass' : 'draw' }];

    const counts = {};
    for (const c of p.hand) if (c.color !== 'wild') counts[c.color] = (counts[c.color] || 0) + 1;
    const danger = this.peek(1).hand.length <= 2;
    const score = c => {
      let s;
      if (isNumber(c)) s = 1 + Number(c.value) / 10;
      else if (c.value === 'wild') s = -2;
      else if (c.value === 'wild4') s = danger ? 6 : -3;
      else s = danger ? 5 : 2;
      if (c.color !== 'wild') s += (counts[c.color] || 0) * 0.3;
      return s + Math.random() * 0.5;
    };
    const card = playable.map(c => [score(c), c]).sort((a, b) => b[0] - a[0])[0][1];

    const moves = [];
    // Bots sometimes forget to call UNO, so people get a chance to catch them.
    if (p.hand.length === 2 && Math.random() < 0.8) moves.push({ type: 'uno' });
    let color;
    if (card.color === 'wild') {
      const left = {};
      for (const c of p.hand) if (c !== card && c.color !== 'wild') left[c.color] = (left[c.color] || 0) + 1;
      const best = Object.entries(left).sort((a, b) => b[1] - a[1])[0];
      color = best ? best[0] : COLORS[crypto.randomInt(4)];
    }
    moves.push({ type: 'play', cardId: card.id, color });
    return moves;
  }

  // What one player is allowed to see.
  view(forId) {
    const me = this.player(forId);
    const cur = this.status === 'playing' ? this.current() : null;
    const now = Date.now();
    const v = this.unoVulnerable && this.unoVulnerable.until > now ? this.unoVulnerable : null;
    return {
      code: this.code,
      status: this.status,
      round: this.round,
      hostId: this.hostId,
      settings: this.settings,
      target: this.target,
      gameNo: this.gameNo,
      // What a new game would be with this many players (shown in the lobby).
      goal: goalFor(this.players.length),
      me: forId,
      players: this.players.map(p => ({
        id: p.id, name: p.name, avatar: p.avatar, bot: p.bot, autoBot: p.autoBot, connected: p.connected,
        count: p.hand.length, score: p.score, calledUno: p.calledUno,
      })),
      hand: me ? me.hand : [],
      playable: me ? this.playableIds(me) : [],
      top: this.top() || null,
      recent: this.discard.slice(-4),
      color: this.color,
      turn: cur ? cur.id : null,
      turnSeq: this.turnSeq,
      direction: this.direction,
      pendingDraw: this.pendingDraw,
      pendingType: this.pendingType,
      drawnCardId: this.drawnCardId,
      timeLeft: cur && this.turnDeadline ? Math.max(0, this.turnDeadline - now) : null,
      timeTotal: cur && this.turnDeadline ? this.turnDeadline - this.turnStarted : null,
      uno: v ? { pid: v.pid, left: v.until - now } : null,
      deckCount: this.deck.length,
      events: this.events.slice(-15),
      result: this.result,
    };
  }
}

module.exports = { Room, MAX_PLAYERS, LOBBY_DROP_MS, STAND_IN_MS, GAME_TARGETS, goalFor, COLORS, makeDeck, points };
