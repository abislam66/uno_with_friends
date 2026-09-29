'use strict';
// Rule checks + hundreds of simulated bot games. Run: npm test
const assert = require('assert');
const { Room } = require('./uno');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}

function room(n, settings = {}) {
  const r = new Room('TEST');
  for (let i = 0; i < n; i++) r.addPlayer({ name: 'P' + i, avatar: '😎' });
  Object.assign(r.settings, settings);
  r.newRound();
  return r;
}
const total = r => r.deck.length + r.discard.length + r.players.reduce((s, p) => s + p.hand.length, 0);
let fake = 0;
const card = (color, value) => ({ id: 'x' + fake++, color, value });
// Put player index `i` on turn with a chosen hand, on top of a chosen card.
function setup(r, i, hand, top = card('red', '5')) {
  r.turn = i;
  r.players[i].hand = hand;
  r.discard.push(top);
  r.color = top.color === 'wild' ? 'red' : top.color;
}

console.log('\nRules');

test('deck has 108 cards and everyone gets 7', () => {
  const r = room(4);
  assert.strictEqual(total(r), 108);
  for (const p of r.players) assert.strictEqual(p.hand.length, 7);
  assert.match(r.top().value, /^\d$/);
});

test('stacking: +2 then +2 means the third player takes 4', () => {
  const r = room(3, { stacking: true });
  const [a, b, c] = r.players;
  setup(r, 0, [card('red', 'draw2'), card('blue', '1')]);
  b.hand = [card('green', 'draw2'), card('blue', '3')];
  c.hand = [card('yellow', '7'), card('blue', '8')];
  assert.strictEqual(r.play(a, a.hand[0].id), null);
  assert.strictEqual(r.current(), b);
  assert.strictEqual(r.pendingDraw, 2);
  assert.deepStrictEqual(r.playableIds(b), [b.hand[0].id], 'only the +2 can be played');
  assert.strictEqual(r.play(b, b.hand[0].id), null);
  assert.strictEqual(r.current(), c);
  assert.strictEqual(r.pendingDraw, 4);
  assert.deepStrictEqual(r.playableIds(c), [], 'player 3 has nothing to stack');
  r.autoMove(c, 'noMoves');
  assert.strictEqual(c.hand.length, 6, 'player 3 took 4 cards');
  assert.strictEqual(r.pendingDraw, 0);
  assert.strictEqual(r.current(), a, 'player 3 lost their turn');
});

test('stacking: a +4 can go on a +2, but a +2 cannot go on a +4', () => {
  const r = room(3, { stacking: true });
  const [a, b, c] = r.players;
  setup(r, 0, [card('red', 'draw2'), card('blue', '1')]);
  b.hand = [card('wild', 'wild4'), card('blue', '3')];
  c.hand = [card('red', 'draw2'), card('blue', '8')];
  r.play(a, a.hand[0].id);
  assert.strictEqual(r.play(b, b.hand[0].id, 'green'), null);
  assert.strictEqual(r.pendingDraw, 6);
  assert.deepStrictEqual(r.playableIds(c), []);
});

test('no stacking: +2 makes the next player draw 2 and skips them', () => {
  const r = room(3, { stacking: false });
  const [a, b, c] = r.players;
  setup(r, 0, [card('red', 'draw2'), card('blue', '1')]);
  const before = b.hand.length;
  r.play(a, a.hand[0].id);
  assert.strictEqual(b.hand.length, before + 2);
  assert.strictEqual(r.current(), c);
});

test('no playable card: the game draws for you, and a match can still be played', () => {
  const r = room(2, { turnSeconds: 20 });
  const [a] = r.players;
  setup(r, 0, [card('blue', '1'), card('green', '2')], card('red', '5'));
  r.deck.push(card('red', '9')); // next draw matches
  assert.deepStrictEqual(r.playableIds(a), []);
  r.autoMove(a, 'noMoves');
  assert.strictEqual(r.current(), a, 'still your turn so you can play the match');
  assert.strictEqual(r.playableIds(a).length, 1);
  assert.strictEqual(r.pass(a), null);
  assert.strictEqual(r.current(), r.players[1]);
});

test('no playable card and the draw does not match: turn passes automatically', () => {
  const r = room(2);
  const [a, b] = r.players;
  setup(r, 0, [card('blue', '1')], card('red', '5'));
  r.deck.push(card('green', '2'));
  r.autoMove(a, 'noMoves');
  assert.strictEqual(a.hand.length, 2);
  assert.strictEqual(r.current(), b);
});

test('timer runs out: draw one card and the turn ends even if it matches', () => {
  const r = room(3, { turnSeconds: 15 });
  const [a, b] = r.players;
  setup(r, 0, [card('red', '1'), card('red', '2')], card('red', '5'));
  r.deck.push(card('red', '9'));
  r.autoMove(a, 'timeout');
  assert.strictEqual(a.hand.length, 3);
  assert.strictEqual(r.current(), b);
  assert.ok(r.turnDeadline > Date.now(), 'next player gets a fresh timer');
});

test('forgetting UNO lets others catch you for +2', () => {
  const r = room(3);
  const [a, b] = r.players;
  setup(r, 0, [card('red', '1'), card('blue', '2')], card('red', '5'));
  r.play(a, a.hand[0].id);
  assert.strictEqual(r.unoVulnerable.pid, a.id);
  assert.strictEqual(r.catchUno(b, a.id), null);
  assert.strictEqual(a.hand.length, 3);
  assert.notStrictEqual(r.catchUno(b, a.id), null, 'cannot catch twice');
});

test('calling UNO first keeps you safe', () => {
  const r = room(3);
  const [a, b] = r.players;
  setup(r, 0, [card('red', '1'), card('blue', '2')], card('red', '5'));
  assert.strictEqual(r.callUno(a), null);
  r.play(a, a.hand[0].id);
  assert.strictEqual(r.unoVulnerable, null);
  assert.notStrictEqual(r.catchUno(b, a.id), null);
});

test('reverse with two players works like skip', () => {
  const r = room(2);
  const [a] = r.players;
  setup(r, 0, [card('red', 'reverse'), card('blue', '2')], card('red', '5'));
  r.play(a, a.hand[0].id);
  assert.strictEqual(r.current(), a);
});

test('reverse with three players changes direction', () => {
  const r = room(3);
  const [a, , c] = r.players;
  setup(r, 0, [card('red', 'reverse'), card('blue', '2')], card('red', '5'));
  r.play(a, a.hand[0].id);
  assert.strictEqual(r.current(), c);
  assert.strictEqual(r.direction, -1);
});

test('wild cards need a color, and the color sticks', () => {
  const r = room(2);
  const [a] = r.players;
  setup(r, 0, [card('wild', 'wild'), card('blue', '2')], card('red', '5'));
  assert.notStrictEqual(r.play(a, a.hand[0].id), null);
  assert.strictEqual(r.play(a, a.hand[0].id, 'green'), null);
  assert.strictEqual(r.color, 'green');
});

test('playing out of turn or a non-matching card is refused', () => {
  const r = room(2);
  const [a, b] = r.players;
  setup(r, 0, [card('blue', '2'), card('green', '3')], card('red', '5'));
  assert.notStrictEqual(r.play(b, b.hand[0].id), null);
  assert.notStrictEqual(r.play(a, a.hand[0].id), null);
});

test('winning adds up the points left in other hands', () => {
  const r = room(2);
  const [a, b] = r.players;
  setup(r, 0, [card('red', '1')], card('red', '5'));
  b.hand = [card('blue', '7'), card('wild', 'wild'), card('green', 'skip')];
  a.calledUno = true;
  r.play(a, a.hand[0].id);
  assert.strictEqual(r.status, 'roundOver');
  assert.strictEqual(r.result.points, 7 + 50 + 20);
  assert.strictEqual(a.score, 77);
});

console.log('\nSimulated games');

test('500 bot games finish, never lose a card, and never make an illegal move', () => {
  let moves = 0;
  for (let g = 0; g < 500; g++) {
    const n = 2 + (g % 7);
    const r = new Room('SIM');
    for (let i = 0; i < n; i++) r.addBot();
    r.settings.stacking = g % 2 === 0;
    r.newRound();
    let steps = 0;
    while (r.status === 'playing') {
      const cur = r.current();
      for (const a of r.botMoves(cur)) {
        const err = r.act(cur, a);
        assert.strictEqual(err, null, `game ${g}: ${a.type} failed: ${err}`);
      }
      if (r.unoVulnerable && Math.random() < 0.5) {
        const other = r.players.find(p => p.id !== r.unoVulnerable.pid);
        r.catchUno(other, r.unoVulnerable.pid);
      }
      assert.strictEqual(total(r), 108, `game ${g}: card count is ${total(r)}`);
      if (++steps > 5000) throw new Error(`game ${g} did not finish`);
    }
    moves += steps;
    assert.ok(r.result && r.players.find(p => p.id === r.result.winnerId).hand.length === 0);
  }
  console.log(`    (${moves} turns played)`);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}\n`);
