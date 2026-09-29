'use strict';
(() => {
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const AVATARS = ['😎', '🦊', '🐼', '🐸', '🦄', '🐯', '🐙', '👻', '🤠', '🐵', '🦖', '🍕', '🐧', '🦁', '👽', '🌮'];
  const REACTIONS = ['😂', '😡', '😱', '🔥', '👏', '😎', '🥶', '💀', '🙏', '🤡'];
  const HEX = { red: '#f5334f', yellow: '#ffc619', green: '#1fbf6b', blue: '#2f7cf6' };
  const COLOR_NAME = { red: 'Red', yellow: 'Yellow', green: 'Green', blue: 'Blue' };
  const COLOR_ORDER = { red: 0, yellow: 1, green: 2, blue: 3, wild: 4 };
  const valueRank = v => (/^\d$/.test(v) ? Number(v) : { skip: 10, reverse: 11, draw2: 12, wild: 13, wild4: 14 }[v]);
  const BASE_TITLE = 'UNO Party';
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ICON = {
    skip: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="3.2"/><path d="M6 18L18 6" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/></svg>',
    reverse: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h13.5M14 5l4 4-4 4M20 15H6.5M10 11l-4 4 4 4" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  // ---------- storage (can be blocked, so never trust it) ----------
  function load(store, key, fallback) {
    try { const v = store.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  }
  function save(store, key, value) {
    try { if (value == null) store.removeItem(key); else store.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  }

  let profile = load(localStorage, 'uno:profile', null) || { name: '', avatar: AVATARS[Math.floor(Math.random() * AVATARS.length)] };
  let session = load(sessionStorage, 'uno:session', null); // per tab, so two tabs = two players
  let state = null;
  let es = null;
  let lastEventId = null;
  let lastTurnKey = null;
  let lastTickSecond = null;
  let resultShownFor = null;
  let busy = false;
  let turnEndsAt = 0;
  let lanUrl = null;
  let inviteLink = '';
  let welcomeBack = false;
  let seatTouched = 0;
  let rejoinSeat = null;

  // Seats are also kept in localStorage (survives closing the browser) so people can rejoin.
  // The per-tab session above still decides which seat a tab is in, so a second tab can be a second player.
  const SEAT_TTL = 12 * 60 * 60 * 1000;
  function loadSeats() {
    const seats = load(localStorage, 'uno:seats', {});
    return seats && typeof seats === 'object' ? seats : {};
  }
  function rememberSeat(s) {
    const seats = loadSeats();
    seats[s.code] = { code: s.code, token: s.token, id: s.id, at: Date.now() };
    const recent = Object.values(seats).sort((a, b) => b.at - a.at).slice(0, 5);
    save(localStorage, 'uno:seats', Object.fromEntries(recent.map(x => [x.code, x])));
  }
  function forgetSeat(code) {
    const seats = loadSeats();
    delete seats[code];
    save(localStorage, 'uno:seats', seats);
  }
  function savedSeat(code) {
    const seats = loadSeats();
    if (code) return seats[code] || null;
    return Object.values(seats).filter(s => Date.now() - s.at < SEAT_TTL).sort((a, b) => b.at - a.at)[0] || null;
  }

  // ---------- sound (tiny synth, no files) ----------
  const Sound = (() => {
    let ctx = null;
    let muted = load(localStorage, 'uno:muted', false);
    function ensure() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
      }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    }
    function tone(freq, { at = 0, dur = 0.15, type = 'sine', vol = 0.16, to = null } = {}) {
      const c = ensure();
      if (!c) return;
      const t = c.currentTime + at;
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(c.destination);
      o.start(t);
      o.stop(t + dur + 0.02);
    }
    const sounds = {
      play: () => tone(520, { dur: 0.09, type: 'triangle', to: 300 }),
      draw: () => tone(300, { dur: 0.12, to: 620, vol: 0.1 }),
      turn: () => { tone(660, { dur: 0.14, type: 'triangle' }); tone(990, { at: 0.13, dur: 0.25, type: 'triangle' }); },
      tick: () => tone(1250, { dur: 0.05, type: 'square', vol: 0.05 }),
      uno: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, { at: i * 0.08, dur: 0.18, type: 'square', vol: 0.08 })),
      bad: () => tone(230, { dur: 0.32, type: 'sawtooth', to: 110, vol: 0.1 }),
      skip: () => tone(520, { dur: 0.14, type: 'triangle', to: 240 }),
      win: () => [523, 659, 784, 659, 784, 1047].forEach((f, i) => tone(f, { at: i * 0.12, dur: 0.26, type: 'triangle', vol: 0.14 })),
      pop: () => tone(820, { dur: 0.06, vol: 0.08 }),
    };
    return {
      play(name) { if (!muted && sounds[name]) try { sounds[name](); } catch { /* ignore */ } },
      unlock: ensure,
      get muted() { return muted; },
      toggle() { muted = !muted; save(localStorage, 'uno:muted', muted); return muted; },
    };
  })();
  document.addEventListener('pointerdown', () => Sound.unlock(), { once: true });

  // ---------- server calls ----------
  async function post(path, body) {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Try again.'), { status: res.status });
    return data;
  }
  async function act(a) {
    if (!session) return;
    try {
      await post('/api/action', { code: session.code, token: session.token, ...a });
    } catch (e) {
      toast(esc(e.message), 'bad');
    }
  }

  // ---------- cards ----------
  function face(c) {
    switch (c.value) {
      case 'skip': return [ICON.skip, ICON.skip];
      case 'reverse': return [ICON.reverse, ICON.reverse];
      case 'draw2': return ['+2', '+2'];
      case 'wild4': return ['+4', '+4'];
      case 'wild': return ['', '<i class="mini-wild"></i>'];
      default: return [c.value, c.value];
    }
  }
  function cardName(c) {
    const v = { skip: 'Skip', reverse: 'Reverse', draw2: 'Draw Two', wild: 'Wild', wild4: 'Wild Draw Four' }[c.value] || c.value;
    return c.color === 'wild' ? v : `${COLOR_NAME[c.color]} ${v}`;
  }
  function cardHTML(c, { tag = 'div', cls = '', style = '', attrs = '' } = {}) {
    const st = style ? ` style="${style}"` : '';
    if (!c) return `<${tag} class="card back ${cls}"${st} ${attrs}><span class="oval"><b>UNO</b></span></${tag}>`;
    const [big, small] = face(c);
    const ul = c.value === '6' || c.value === '9' ? ' underline' : '';
    return `<${tag} class="card ${c.color} v-${c.value}${ul} ${cls}" data-id="${c.id}" aria-label="${cardName(c)}"${st} ${attrs}>`
      + `<span class="corner tl">${small}</span><span class="oval"><span class="sym">${big}</span></span><span class="corner br">${small}</span></${tag}>`;
  }
  function jitter(id) {
    let h = 7;
    for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
    h = Math.abs(h);
    return { r: ((h % 1000) / 1000 * 34 - 17).toFixed(1), x: (h >> 4) % 9 - 4, y: (h >> 8) % 9 - 4 };
  }

  // ---------- screens ----------
  function show(id) {
    for (const s of ['home', 'lobby', 'game']) $('#' + s).classList.toggle('hidden', s !== id);
    // In a game, messages sit on the table above the banner so they never cover players.
    const toasts = $('#toasts');
    const parent = id === 'game' ? $('#table') : document.body;
    if (toasts.parentElement !== parent) {
      toasts.innerHTML = '';
      parent.appendChild(toasts);
    }
    toasts.classList.toggle('in-table', id === 'game');
  }

  // ---------- home ----------
  function initHome() {
    $('#name').value = profile.name;
    renderAvatars();
    floaters();
    const room = (new URLSearchParams(location.search).get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    if (room) {
      $('#code').value = room;
      $('#join').textContent = 'Join ' + room;
    }
    $('#create').onclick = () => enter('create');
    $('#join').onclick = () => enter('join');
    $('#rejoin-btn').onclick = () => { if (rejoinSeat) startSession(rejoinSeat, true); };
    $('#rejoin-leave').onclick = async () => {
      const seat = rejoinSeat;
      $('#rejoin').classList.add('hidden');
      rejoinSeat = null;
      if (!seat) return;
      forgetSeat(seat.code);
      try { await post('/api/leave', { code: seat.code, token: seat.token }); } catch { /* ignore */ }
    };
    $('#code').addEventListener('input', e => {
      e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
      $('#join').textContent = 'Join';
    });
    $('#code').addEventListener('keydown', e => { if (e.key === 'Enter') enter('join'); });
    $('#name').addEventListener('keydown', e => { if (e.key === 'Enter') enter($('#code').value ? 'join' : 'create'); });
  }

  function renderAvatars() {
    $('#avatars').innerHTML = AVATARS.map(a =>
      `<button type="button" class="avatar-choice" role="radio" aria-checked="${a === profile.avatar}" aria-label="Avatar ${a}" data-avatar="${a}">${a}</button>`).join('');
    $('#avatars').onclick = e => {
      const b = e.target.closest('[data-avatar]');
      if (!b) return;
      profile.avatar = b.dataset.avatar;
      save(localStorage, 'uno:profile', profile);
      renderAvatars();
      Sound.play('pop');
    };
  }

  function floaters() {
    const kinds = [
      { color: 'red', value: '7' }, { color: 'blue', value: 'reverse' }, { color: 'yellow', value: 'draw2' },
      { color: 'green', value: 'skip' }, { color: 'wild', value: 'wild' }, { color: 'wild', value: 'wild4' },
      { color: 'blue', value: '2' }, { color: 'green', value: '9' }, { color: 'yellow', value: '0' },
      { color: 'red', value: 'draw2' }, null, { color: 'green', value: '5' },
    ];
    $('#floaters').innerHTML = kinds.map((c, i) => {
      const left = (i * 8.3 + Math.random() * 5) % 96;
      const top = (i % 2 ? 8 : 62) + Math.random() * 26;
      const style = `left:${left}%;top:${top}%;--d:${7 + Math.random() * 6}s;--r0:${-25 + Math.random() * 20}deg;--r1:${5 + Math.random() * 25}deg;animation-delay:${-Math.random() * 8}s`;
      return cardHTML(c && { ...c, id: 'f' + i }, { style });
    }).join('');
  }

  async function enter(kind) {
    const err = $('#home-error');
    err.textContent = '';
    const name = $('#name').value.trim();
    if (!name) {
      err.textContent = 'Type your name first.';
      $('#name').focus();
      return;
    }
    profile.name = name;
    save(localStorage, 'uno:profile', profile);
    const code = $('#code').value.trim().toUpperCase();
    if (kind === 'join' && code.length !== 4) {
      err.textContent = 'Room codes have 4 letters.';
      $('#code').focus();
      return;
    }
    const btn = kind === 'create' ? $('#create') : $('#join');
    btn.disabled = true;
    try {
      const data = await post('/api/' + kind, { name, avatar: profile.avatar, code });
      startSession(data);
    } catch (e) {
      err.textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  }

  function startSession(data, rejoining = false) {
    session = { code: data.code, token: data.token, id: data.id };
    save(sessionStorage, 'uno:session', session);
    rememberSeat(session);
    seatTouched = Date.now();
    welcomeBack = rejoining;
    history.replaceState(null, '', '?room=' + data.code);
    connect();
  }

  // On the start screen: "You're still in game ABCD" if a saved seat is still at the table.
  async function offerRejoin(code) {
    const box = $('#rejoin');
    box.classList.add('hidden');
    const seat = savedSeat(code);
    if (!seat) return;
    let info;
    try {
      info = await post('/api/seat', { code: seat.code, token: seat.token });
    } catch (e) {
      if (e.status === 403 || e.status === 404) forgetSeat(seat.code); // that game is over
      return;
    }
    if (session) return; // joined something else in the meantime
    rejoinSeat = seat;
    const where = info.status === 'playing'
      ? `Round ${info.round} is still going. You have ${info.cards} card${info.cards === 1 ? '' : 's'}.`
      : info.status === 'roundOver' ? `Round ${info.round} just ended. You have ${info.score} points.` : 'Your friends are waiting in the lobby.';
    $('#rejoin-avatar').textContent = info.avatar;
    $('#rejoin-title').textContent = `${info.name}, you're still in game ${seat.code}!`;
    $('#rejoin-sub').textContent = where;
    $('#rejoin-btn').textContent = `↩ Rejoin game ${seat.code}`;
    box.classList.remove('hidden');
  }

  function connect() {
    if (es) es.close();
    state = null;
    lastEventId = null;
    lastTurnKey = null;
    resultShownFor = null;
    es = new EventSource(`/events?code=${encodeURIComponent(session.code)}&token=${encodeURIComponent(session.token)}`);
    es.onmessage = e => onState(JSON.parse(e.data));
    es.addEventListener('gone', () => {
      if (session) forgetSeat(session.code);
      goHome(state ? 'That room has closed.' : '');
    });
    es.addEventListener('react', e => showReaction(JSON.parse(e.data)));
  }

  function goHome(msg) {
    if (es) es.close();
    es = null;
    session = null;
    state = null;
    save(sessionStorage, 'uno:session', null);
    history.replaceState(null, '', location.pathname);
    $('#result-modal').classList.add('hidden');
    closeColor(null);
    flashTitle(false);
    show('home');
    $('#rejoin').classList.add('hidden');
    $('#home-error').textContent = msg || '';
  }

  async function leaveRoom() {
    if (state && state.status === 'playing' && !confirm('Leave the game? A computer player will take your seat.')) return;
    const s = session;
    goHome('');
    if (!s) return;
    forgetSeat(s.code);
    try { await post('/api/leave', { code: s.code, token: s.token }); } catch { /* ignore */ }
  }

  // ---------- state updates ----------
  function onState(s) {
    const prev = state;
    const fresh = lastEventId === null;
    const newEvents = fresh ? [] : s.events.filter(e => e.id > lastEventId).slice(-8);
    lastEventId = s.events.length ? s.events[s.events.length - 1].id : lastEventId || 0;
    if (fresh && welcomeBack) {
      welcomeBack = false;
      setTimeout(() => toast('🎉 Welcome back! You have your seat again', 'good'), 300);
    }
    if (session && Date.now() - seatTouched > 60000) {
      seatTouched = Date.now();
      rememberSeat(session);
    }

    // Measure where played cards come from before the DOM changes.
    const origins = {};
    for (const e of newEvents) if (e.type === 'play') origins[e.id] = originBox(e.pid, e.card.id);

    state = s;
    turnEndsAt = s.timeLeft != null ? performance.now() + s.timeLeft : 0;
    if (s.status === 'lobby') {
      show('lobby');
      renderLobby(s);
    } else {
      show('game');
      renderGame(s, prev, newEvents);
    }
    for (const e of newEvents) handleEvent(e, origins[e.id], s);
    checkTurn(s);
    syncModals(s);
  }

  // ---------- lobby ----------
  function initLobby() {
    $('#copy-link').onclick = copyInvite;
    $('#add-bot').onclick = () => act({ type: 'addBot' });
    $('#start').onclick = () => act({ type: 'start' });
    $('#rule-stack').onchange = e => act({ type: 'settings', stacking: e.target.checked });
    $('#rule-timer').onchange = e => act({ type: 'settings', turnSeconds: Number(e.target.value) });
    $('#rule-length').onchange = e => act({ type: 'settings', endless: e.target.value === 'endless' });
    $('#leave-lobby').onclick = leaveRoom;
    $('#lobby-players').onclick = e => {
      const b = e.target.closest('[data-kick]');
      if (b) act({ type: 'kick', target: b.dataset.kick });
    };
  }

  function renderLobby(s) {
    const isHost = s.hostId === s.me;
    const host = s.players.find(p => p.id === s.hostId);
    $('#lobby-code').textContent = s.code;
    $('#player-count').textContent = `(${s.players.length}/8)`;
    let html = s.players.map(p => {
      const tags = [
        p.id === s.hostId && '👑 Host',
        p.autoBot ? '🤖 Computer playing for them' : p.bot && '🤖 Computer',
        !p.connected && !p.autoBot && '💤 Reconnecting…',
      ].filter(Boolean).join(' · ') || '✅ Ready';
      return `<li><span class="av">${esc(p.avatar)}</span>
        <span class="nm">${esc(p.name)}${p.id === s.me ? ' (you)' : ''}<small>${tags}</small></span>
        ${isHost && p.id !== s.me ? `<button class="kick" data-kick="${p.id}" aria-label="Remove ${esc(p.name)}">✕</button>` : ''}</li>`;
    }).join('');
    if (s.players.length < 2) html += '<li class="empty">Waiting for friends…</li>';
    $('#lobby-players').innerHTML = html;

    $('#host-controls').classList.toggle('hidden', !isHost);
    $('#add-bot').disabled = s.players.length >= 8;
    $('#rule-stack').checked = s.settings.stacking;
    $('#rule-timer').value = String(s.settings.turnSeconds);
    $('#rule-length').value = s.settings.endless ? 'endless' : 'goal';
    // The goal grows with the number of players, so the game stays about as long as promised.
    const [lo, hi] = s.goal.minutes;
    const length = s.settings.endless
      ? 'No limit: keep playing rounds until you stop'
      : `First to <b>${s.goal.target} points</b> wins · about ${lo}–${hi} min${s.players.length < 2 ? ' with 2 players' : ''}`;
    $('#length-hint').innerHTML = length;
    const start = $('#start');
    start.disabled = s.players.length < 2;
    start.textContent = s.players.length < 2 ? 'Need 2+ players to start' : `▶ Start game (${s.players.length} players)`;
    $('#guest-info').innerHTML = isHost ? '' : `⏳ Waiting for <b>${esc(host ? host.name : 'the host')}</b> to start the game.<br>
      Rules: ${s.settings.stacking ? '<b>stacking on</b> (+2 on a +2 = take 4)' : 'no stacking'} · ${s.settings.turnSeconds ? `<b>${s.settings.turnSeconds} second</b> turn timer` : 'no turn timer'}<br>
      ${length}`;
    shareHint(s.code);
  }

  async function shareHint(code) {
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    if (local && lanUrl === null) {
      lanUrl = '';
      try {
        const info = await (await fetch('/api/info')).json();
        if (info.lan && info.lan[0]) lanUrl = `http://${info.lan[0]}:${info.port}`;
      } catch { /* ignore */ }
    }
    const base = local && lanUrl ? lanUrl : location.origin;
    inviteLink = `${base}/?room=${code}`;
    $('#share-hint').innerHTML = local && lanUrl
      ? `📱 Friends on the same Wi-Fi: open <b>${esc(inviteLink)}</b> on their phone or laptop.`
      : '📱 Send your friends the invite link, or tell them the code.';
  }

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(inviteLink);
    } catch {
      const t = document.createElement('textarea');
      t.value = inviteLink;
      document.body.appendChild(t);
      t.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      t.remove();
    }
    toast('🔗 Invite link copied! Send it to your friends', 'good');
  }

  // ---------- game ----------
  function initGame() {
    $('#deck .stack').innerHTML = cardHTML(null).repeat(3);
    $('#deck').onclick = drawCard;
    $('#pass').onclick = () => act({ type: 'pass' });
    $('#uno-btn').onclick = () => act({ type: 'uno' });
    $('#leave-game').onclick = leaveRoom;
    $('#mute').onclick = () => {
      const m = Sound.toggle();
      $('#mute').textContent = m ? '🔇' : '🔊';
      $('#mute').setAttribute('aria-label', m ? 'Turn sound on' : 'Turn sound off');
    };
    $('#mute').textContent = Sound.muted ? '🔇' : '🔊';

    $('#hand').onclick = e => {
      const c = e.target.closest('.card[data-id]');
      if (c) playCard(c.dataset.id);
    };
    $('#seats').onclick = e => {
      const b = e.target.closest('[data-catch]');
      if (b) act({ type: 'catch', target: b.dataset.catch });
    };

    const pop = $('#react-pop');
    pop.innerHTML = REACTIONS.map(r => `<button type="button" data-emoji="${r}" aria-label="React ${r}">${r}</button>`).join('');
    $('#react-btn').onclick = e => {
      e.stopPropagation();
      pop.classList.toggle('hidden');
      $('#react-btn').setAttribute('aria-expanded', String(!pop.classList.contains('hidden')));
    };
    pop.onclick = e => {
      const b = e.target.closest('[data-emoji]');
      if (!b || !session) return;
      post('/api/react', { code: session.code, token: session.token, emoji: b.dataset.emoji }).catch(() => {});
      pop.classList.add('hidden');
    };
    document.addEventListener('click', e => { if (!e.target.closest('.react-wrap')) pop.classList.add('hidden'); });

    $('#color-modal').onclick = e => {
      const b = e.target.closest('[data-color]');
      if (b) closeColor(b.dataset.color);
      else if (e.target.id === 'color-cancel' || e.target.id === 'color-modal') closeColor(null);
    };
    $('#result-actions').onclick = e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'leave') leaveRoom();
      else act({ type: b.dataset.act });
    };

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeColor(null);
      if (!state || state.status !== 'playing' || e.target.closest('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'u' || e.key === 'U') { if (!$('#uno-btn').disabled) act({ type: 'uno' }); }
      else if (e.key === 'd' || e.key === 'D') drawCard();
    });
    addEventListener('resize', layoutHand);
    document.addEventListener('visibilitychange', () => {
      if (state) flashTitle(isMyTurn(state) && document.hidden);
    });
  }

  const isMyTurn = s => s && s.status === 'playing' && s.turn === s.me;

  function renderGame(s, prev, newEvents) {
    $('#game').style.setProperty('--cur', HEX[s.color] || '#a78bfa');
    $('#g-code').textContent = s.code;
    $('#g-round').textContent = `Round ${s.round}`;
    $('#g-goal').innerHTML = s.target ? `🏁 <span class="long">First to </span>${s.target}` : '♾️ <span class="long">No limit</span>';
    $('#g-color').textContent = s.color ? COLOR_NAME[s.color] : '-';
    renderSeats(s);
    renderCenter(s);
    renderMe(s, prev, newEvents);
    renderBanner(s);
  }

  // Opponents sit around the top half of the table, in turn order (clockwise).
  function renderSeats(s) {
    const i = s.players.findIndex(p => p.id === s.me);
    const n = s.players.length;
    const others = Array.from({ length: n - 1 }, (_, k) => s.players[(i + 1 + k) % n]);
    $('#seats').innerHTML = others.map((p, k) => {
      const angle = Math.PI + ((k + 1) * Math.PI) / (others.length + 1);
      const x = Math.min(89, Math.max(11, 50 + 42 * Math.cos(angle)));
      const y = Math.max(13, 50 + 38 * Math.sin(angle));
      const turn = s.turn === p.id;
      const vulnerable = s.uno && s.uno.pid === p.id;
      const ring = turn && s.timeTotal
        ? '<svg class="timer-ring" viewBox="0 0 100 100"><circle class="track" cx="50" cy="50" r="46"/><circle class="left" cx="50" cy="50" r="46" pathLength="100" stroke-dasharray="100" stroke-dashoffset="0"/></svg>'
        : '';
      const badge = p.count === 1 ? `<span class="badge-uno">${p.calledUno ? 'UNO!' : '1 card!'}</span>` : '';
      return `<div class="seat${turn ? ' turn' : ''}${p.connected ? '' : ' away'}" data-pid="${p.id}" style="left:${x.toFixed(1)}%;top:${y.toFixed(1)}%">
        <div class="mini-hand">${cardHTML(null).repeat(Math.min(p.count, 10))}</div>
        <div class="avatar-wrap">${badge}<div class="avatar">${esc(p.avatar)}</div>${ring}<span class="count" title="${p.count} cards">${p.count}</span></div>
        <div class="name">${esc(p.name)}</div>
        <div class="sub">${p.score} pts${p.autoBot ? ' · 🤖 standing in' : p.bot ? ' · 🤖' : p.connected ? '' : ' · 💤 away'}</div>
        ${vulnerable ? `<button class="catch-btn" data-catch="${p.id}" aria-label="Catch ${esc(p.name)} for not calling UNO">Catch! 🫵</button>` : ''}
      </div>`;
    }).join('');
  }

  function renderCenter(s) {
    const canDraw = isMyTurn(s) && !s.drawnCardId;
    const deck = $('#deck');
    deck.disabled = !canDraw;
    deck.classList.toggle('can-draw', canDraw);
    deck.classList.toggle('take', canDraw && s.pendingDraw > 0);
    $('#deck-label').textContent = canDraw ? (s.pendingDraw ? `Take ${s.pendingDraw}` : 'Draw') : `${s.deckCount} left`;
    deck.setAttribute('aria-label', canDraw ? (s.pendingDraw ? `Take ${s.pendingDraw} cards` : 'Draw a card') : `Draw pile, ${s.deckCount} cards`);
    $('#discard').innerHTML = s.recent.map(c => {
      const j = jitter(c.id);
      return cardHTML(c, { style: `--r:${j.r}deg;--x:${j.x}px;--y:${j.y}px` });
    }).join('');
    $('#discard-label').textContent = s.pendingDraw ? `+${s.pendingDraw} stacked!` : s.color ? `Color: ${COLOR_NAME[s.color]}` : '';
    $('#dir-ring').classList.toggle('ccw', s.direction < 0);
  }

  function renderMe(s, prev, newEvents) {
    const me = s.players.find(p => p.id === s.me) || {};
    const mine = isMyTurn(s);
    $('#me-avatar').textContent = me.avatar || '';
    $('#me-name').textContent = me.name || '';
    $('#me-score').textContent = `${me.score || 0} pts · ${s.hand.length} card${s.hand.length === 1 ? '' : 's'}`;
    $('#me').classList.toggle('my-turn', mine);
    $('#pass').classList.toggle('hidden', !(mine && s.drawnCardId));

    const uno = $('#uno-btn');
    const canUno = s.status === 'playing' && s.hand.length > 0 && s.hand.length <= 2 && !me.calledUno;
    uno.disabled = !canUno;
    uno.classList.toggle('urgent', canUno && ((mine && s.hand.length === 2 && s.playable.length > 0) || !!(s.uno && s.uno.pid === s.me)));

    const dealing = newEvents.some(e => e.type === 'start');
    const prevIds = new Set(prev && prev.status !== 'lobby' ? prev.hand.map(c => c.id) : []);
    const sorted = s.hand.slice().sort((a, b) => COLOR_ORDER[a.color] - COLOR_ORDER[b.color] || valueRank(a.value) - valueRank(b.value));
    const playable = new Set(s.playable);
    const n = sorted.length;
    const spread = Math.min(3, 26 / Math.max(n, 1));
    const hand = $('#hand');
    hand.classList.toggle('my-turn', mine);
    hand.classList.toggle('dealing', dealing);
    hand.innerHTML = sorted.map((c, i) => {
      const cls = [
        playable.has(c.id) ? 'playable' : '',
        c.id === s.drawnCardId ? 'drawn' : '',
        !dealing && prev && !prevIds.has(c.id) ? 'new' : '',
      ].join(' ');
      const rot = ((i - (n - 1) / 2) * spread).toFixed(2);
      return cardHTML(c, { tag: 'button', cls, style: `--rot:${rot}deg;--i:${i}`, attrs: 'type="button"' });
    }).join('');
    layoutHand();
  }

  // Overlap cards so the whole hand fits; scroll sideways if it still doesn't.
  function layoutHand() {
    const hand = $('#hand');
    const first = hand.firstElementChild;
    if (!first) return;
    const n = hand.children.length;
    const cw = first.offsetWidth;
    const avail = $('#hand-scroll').clientWidth - 40;
    let ov = n > 1 ? (avail - n * cw) / (n - 1) : 0;
    ov = Math.max(-cw * 0.62, Math.min(4, ov));
    hand.style.setProperty('--ov', ov.toFixed(1) + 'px');
  }

  function renderBanner(s) {
    const b = $('#banner');
    b.className = 'banner';
    if (s.status !== 'playing') {
      b.textContent = s.status === 'roundOver' ? '🏁 Round over!' : '';
      return;
    }
    const cur = s.players.find(p => p.id === s.turn);
    if (s.turn === s.me) {
      b.classList.add('mine');
      if (s.pendingDraw && !s.playable.length) b.textContent = `😬 Nothing to stack. Taking ${s.pendingDraw} cards…`;
      else if (s.pendingDraw) b.textContent = `💥 +${s.pendingDraw} at you! Stack a +2/+4, or tap the deck`;
      else if (s.drawnCardId) b.textContent = '✨ You drew a match! Play it or pass';
      else if (!s.playable.length) b.textContent = '🙈 No match. Drawing a card for you…';
      else b.textContent = '👉 YOUR TURN! Play a glowing card';
    } else if (cur) {
      b.textContent = `${cur.avatar} ${cur.name}'s turn${s.pendingDraw ? `: stack or take ${s.pendingDraw}` : ''}${cur.connected ? '' : ' (away)'}…`;
    }
  }

  // ---------- playing ----------
  async function playCard(id) {
    const s = state;
    if (!s || s.status !== 'playing' || busy) return;
    const el = document.querySelector(`#hand [data-id="${id}"]`);
    if (s.turn !== s.me) return nudge(el, '✋ Wait for your turn');
    if (!s.playable.includes(id)) {
      return nudge(el, s.pendingDraw
        ? `Only a +2 or +4 can stack. Or tap the deck to take ${s.pendingDraw}.`
        : s.drawnCardId ? 'You can only play the card you just drew, or pass.' : "That card doesn't match. Try a glowing one.");
    }
    const card = s.hand.find(c => c.id === id);
    let color;
    if (card.color === 'wild') {
      color = await pickColor(s.hand.filter(c => c.id !== id));
      if (!color || !isMyTurn(state)) return;
    }
    busy = true;
    await act({ type: 'play', cardId: id, color });
    busy = false;
  }

  async function drawCard() {
    const s = state;
    if (!isMyTurn(s) || s.drawnCardId || busy) return;
    busy = true;
    await act({ type: 'draw' });
    busy = false;
  }

  function nudge(el, msg) {
    if (el) {
      el.classList.remove('shake');
      void el.offsetWidth;
      el.classList.add('shake');
    }
    toast(esc(msg));
  }

  let colorResolve = null;
  function pickColor(rest) {
    const counts = { red: 0, yellow: 0, green: 0, blue: 0 };
    for (const c of rest) if (c.color in counts) counts[c.color]++;
    for (const b of $$('.color-choice')) {
      const k = b.dataset.color;
      b.innerHTML = `${COLOR_NAME[k]}<br><small>you have ${counts[k]}</small>`;
    }
    return new Promise(resolve => {
      colorResolve = resolve;
      $('#color-modal').classList.remove('hidden');
      $('.color-choice').focus();
    });
  }
  function closeColor(value) {
    if (!colorResolve) return;
    $('#color-modal').classList.add('hidden');
    const r = colorResolve;
    colorResolve = null;
    r(value);
  }

  // ---------- turn alerts ----------
  function checkTurn(s) {
    const key = isMyTurn(s) ? `${s.round}:${s.turnSeq}` : null;
    if (key && key !== lastTurnKey) {
      lastTickSecond = null;
      alertTurn(s);
    }
    if (!key) {
      clearTimeout(splashTimer);
      $('#splash').classList.remove('show');
    }
    lastTurnKey = key;
    flashTitle(!!key && document.hidden);
  }

  function alertTurn(s) {
    if (s.pendingDraw) splash(`+${s.pendingDraw} INCOMING!`);
    else if (!s.playable.length) splash('No match…', true);
    else splash('YOUR TURN!');
    Sound.play(s.pendingDraw ? 'bad' : 'turn');
    try { if (navigator.vibrate) navigator.vibrate(s.pendingDraw ? [90, 60, 90] : 140); } catch { /* ignore */ }
  }

  let splashTimer = null;
  function splash(text, small) {
    const el = $('#splash');
    el.textContent = text;
    el.classList.toggle('small', !!small);
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(splashTimer);
    splashTimer = setTimeout(() => el.classList.remove('show'), 1700);
  }

  let titleTimer = null;
  function flashTitle(on) {
    if (!on) {
      clearInterval(titleTimer);
      titleTimer = null;
      document.title = BASE_TITLE;
      return;
    }
    if (titleTimer) return;
    let flip = false;
    titleTimer = setInterval(() => {
      flip = !flip;
      document.title = flip ? '🔔 YOUR TURN!' : BASE_TITLE;
    }, 800);
  }

  // Timer bar for me, countdown ring for whoever's turn it is.
  function tick() {
    const s = state;
    const meter = $('#meter');
    if (s && s.status === 'playing' && s.timeTotal) {
      const left = Math.max(0, turnEndsAt - performance.now());
      const frac = Math.min(1, left / s.timeTotal);
      const secs = Math.ceil(left / 1000);
      const mine = s.turn === s.me;
      meter.classList.toggle('on', mine);
      if (mine) {
        $('#meter-fill').style.width = (frac * 100).toFixed(1) + '%';
        $('#meter-text').textContent = `⏱ ${secs}s left`;
        meter.classList.toggle('warn', frac <= 0.5 && frac > 0.25);
        meter.classList.toggle('danger', frac <= 0.25);
        $('#banner').classList.toggle('hurry', secs <= 5);
        if (secs <= 5 && secs > 0 && secs !== lastTickSecond) {
          lastTickSecond = secs;
          Sound.play('tick');
        }
      }
      const ring = document.querySelector('.seat.turn .timer-ring .left');
      if (ring) {
        ring.style.strokeDashoffset = (100 * (1 - frac)).toFixed(2);
        ring.style.stroke = frac > 0.5 ? 'var(--green)' : frac > 0.25 ? 'var(--yellow)' : 'var(--red)';
      }
    } else {
      meter.classList.remove('on');
    }
    requestAnimationFrame(tick);
  }

  // ---------- events -> toasts, sounds, animations ----------
  function handleEvent(e, origin, s) {
    const me = pid => pid === s.me;
    const name = pid => (me(pid) ? 'You' : esc((s.players.find(p => p.id === pid) || {}).name || 'Someone'));
    switch (e.type) {
      case 'join':
        if (s.status !== 'playing' && !me(e.pid)) { toast(`👋 ${esc(e.name)} joined`); Sound.play('pop'); }
        break;
      case 'standIn':
        toast(`🤖 ${esc(e.name)} has been away a while, so the computer is playing for them. They can rejoin anytime.`);
        break;
      case 'back':
        if (!me(e.pid)) { toast(`🎉 ${esc(e.name)} is back!`, 'good'); Sound.play('pop'); }
        break;
      case 'leave':
        toast(e.bot ? `🚪 ${esc(e.name)} left. A computer player took their seat.` : `🚪 ${esc(e.name)} left`);
        break;
      case 'start':
        toast(`🃏 Round ${e.round}! ${me(e.pid) ? 'You go' : name(e.pid) + ' goes'} first`, 'big');
        Sound.play('draw');
        dealFx(s);
        break;
      case 'play':
        flyPlay(e, origin);
        Sound.play('play');
        if (e.card.color === 'wild') toast(`🎨 ${name(e.pid)} picked <b style="color:${HEX[e.color]}">${COLOR_NAME[e.color]}</b>`);
        break;
      case 'skip':
        toast(`⛔ ${me(e.pid) ? 'You got' : name(e.pid) + ' got'} skipped!`, me(e.pid) ? 'bad' : '');
        Sound.play('skip');
        break;
      case 'reverse':
        toast(e.again
          ? `🔄 Reverse! ${me(e.again) ? 'You go' : name(e.again) + ' goes'} again`
          : `🔄 Reverse! Now going ${e.direction > 0 ? 'clockwise ↻' : 'the other way ↺'}`);
        Sound.play('skip');
        break;
      case 'stack':
        toast(me(e.pid) ? `💥 +${e.total} coming at you! Stack a +2/+4 or take them` : `💥 +${e.total} heading to ${name(e.pid)}!`, me(e.pid) ? 'bad' : 'big');
        break;
      case 'draw':
        flyDraw(e.pid, e.count, s);
        if (e.forced) {
          toast(me(e.pid) ? `😬 You take ${e.count} cards` : `😬 ${name(e.pid)} takes ${e.count} cards`, me(e.pid) ? 'bad' : '');
          Sound.play(me(e.pid) ? 'bad' : 'draw');
        } else {
          Sound.play('draw');
        }
        break;
      case 'auto':
        if (e.reason === 'timeout') toast(me(e.pid) ? "⏰ Time's up! Your turn is over" : `⏰ Time's up for ${name(e.pid)}!`, me(e.pid) ? 'bad' : '');
        else if (e.reason === 'away') toast(`💤 ${name(e.pid)} is away, so the computer played for them`);
        break;
      case 'uno':
        toast(`📣 ${name(e.pid)}: UNO!`, 'big');
        Sound.play('uno');
        break;
      case 'caught':
        flyDraw(e.target, 2, s);
        toast(me(e.target) ? `🫵 ${name(e.pid)} caught you not calling UNO! +2 cards`
          : me(e.pid) ? `🫵 You caught ${name(e.target)}! +2 cards for them`
            : `🫵 ${name(e.pid)} caught ${name(e.target)}! +2 cards`, me(e.target) ? 'bad' : 'good');
        Sound.play(me(e.target) ? 'bad' : 'uno');
        break;
      case 'reshuffle':
        toast('🔀 Shuffling the played cards back into the deck');
        break;
      case 'win':
        Sound.play('win');
        break;
    }
  }

  // ---------- animations ----------
  function box(el) {
    const r = el.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: el.offsetWidth || r.width };
  }
  function originBox(pid, cardId) {
    if (state && pid === state.me) {
      const el = document.querySelector(`#hand [data-id="${cardId}"]`);
      if (el) return box(el);
    }
    const seat = document.querySelector(`.seat[data-pid="${pid}"] .avatar`);
    return seat && seat.offsetParent ? { ...box(seat), w: seat.offsetWidth * 0.7 } : null;
  }

  // Fly a card from one spot to another. w = card width at the end.
  function fly(html, from, to, { delay = 0, dur = 430, r0 = -20, r1 = 0 } = {}) {
    if (reducedMotion) return Promise.resolve();
    return new Promise(resolve => {
      const el = document.createElement('div');
      el.className = 'flyer';
      el.innerHTML = html;
      el.firstElementChild.style.setProperty('--cw', to.w + 'px');
      document.body.appendChild(el);
      const w = to.w;
      const h = w * 1.5;
      const s0 = from.w / w;
      const anim = el.animate([
        { transform: `translate(${from.cx - w / 2}px, ${from.cy - h / 2}px) rotate(${r0}deg) scale(${s0})` },
        { transform: `translate(${to.cx - w / 2}px, ${to.cy - h / 2}px) rotate(${r1}deg) scale(1)` },
      ], { duration: dur, delay, easing: 'cubic-bezier(.2,.8,.25,1)', fill: 'both' });
      const done = () => { el.remove(); resolve(); };
      anim.onfinish = done;
      anim.oncancel = done;
    });
  }

  function flyPlay(e, origin) {
    const target = $('#discard .card:last-child');
    if (!origin || !target || target.dataset.id !== e.card.id) return;
    target.classList.add('incoming');
    const r1 = parseFloat(target.style.getPropertyValue('--r')) || 0;
    fly(cardHTML(e.card), origin, box(target), { r1 }).then(() => target.classList.remove('incoming'));
  }

  function flyDraw(pid, count, s) {
    const n = Math.min(count || 0, 6);
    const deckCard = $('#deck .stack .card:last-child');
    if (!n || !deckCard || !deckCard.offsetParent) return;
    const from = box(deckCard);
    if (pid === s.me) {
      $$('#hand .card.new').slice(-n).forEach((el, i) => fly(cardHTML(null), from, box(el), { delay: i * 90, r0: 0 }));
    } else {
      const seat = document.querySelector(`.seat[data-pid="${pid}"] .avatar`);
      if (!seat) return;
      const to = { ...box(seat), w: seat.offsetWidth * 0.6 };
      for (let i = 0; i < n; i++) fly(cardHTML(null), { ...from, w: from.w }, to, { delay: i * 90, r0: 0, r1: 25 });
    }
  }

  function dealFx(s) {
    const deckCard = $('#deck .stack .card:last-child');
    if (!deckCard || !deckCard.offsetParent) return;
    const from = box(deckCard);
    $$('.seat .avatar').forEach((seat, k) => {
      const to = { ...box(seat), w: seat.offsetWidth * 0.6 };
      for (let i = 0; i < 3; i++) fly(cardHTML(null), from, to, { delay: (i * s.players.length + k) * 70, r0: 0, r1: 25 });
    });
  }

  function showReaction({ pid, emoji }) {
    if (!state || state.status === 'lobby' || !REACTIONS.includes(emoji)) return;
    const el = pid === state.me ? $('#me-avatar') : document.querySelector(`.seat[data-pid="${pid}"] .avatar`);
    if (!el || !el.offsetParent) return;
    const r = el.getBoundingClientRect();
    const span = document.createElement('span');
    span.className = 'reaction';
    span.textContent = emoji;
    span.style.left = r.left + r.width / 2 + 'px';
    span.style.top = r.top - 20 + 'px';
    document.body.appendChild(span);
    setTimeout(() => span.remove(), 1900);
    Sound.play('pop');
  }

  function toast(html, kind = '') {
    const wrap = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.innerHTML = html;
    wrap.appendChild(el);
    while (wrap.children.length > (wrap.classList.contains('in-table') ? 2 : 3)) wrap.firstElementChild.remove();
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 300);
    }, kind === 'big' ? 2400 : 2100);
  }

  // ---------- round over ----------
  function syncModals(s) {
    if (!isMyTurn(s)) closeColor(null);
    const modal = $('#result-modal');
    if (s.status !== 'roundOver' || !s.result) {
      modal.classList.add('hidden');
      return;
    }
    const key = `${s.gameNo}:${s.round}`;
    if (resultShownFor !== key) {
      resultShownFor = key;
      // Let the last card land before the results pop up.
      setTimeout(() => {
        if (state && state.status === 'roundOver') {
          renderResult(state);
          modal.classList.remove('hidden');
          confetti(state.result.gameOver ? 320 : state.result.winnerId === state.me ? 220 : 90);
        }
      }, 900);
    } else if (!modal.classList.contains('hidden')) {
      renderResult(s);
    }
  }

  function renderResult(s) {
    const w = s.players.find(p => p.id === s.result.winnerId);
    const iWon = s.result.winnerId === s.me;
    const over = s.result.gameOver;
    const name = w ? w.name : 'Someone';
    $('.result-card').classList.toggle('champion', over);
    $('#result-avatar').textContent = w ? w.avatar : '🏆';
    $('#result-title').textContent = over
      ? (iWon ? '👑 You win the game!' : `👑 ${name} wins the game!`)
      : (iWon ? 'You won the round! 🎉' : `${name} wins round ${s.round}!`);
    $('#result-points').textContent = over
      ? `Reached ${s.target} points in ${s.round} round${s.round === 1 ? '' : 's'}`
      : `+${s.result.points} points${s.target ? ` · first to ${s.target} wins the game` : ''}`;
    $('#scoreboard').innerHTML = s.players.slice().sort((a, b) => b.score - a.score).map((p, i) => {
      const left = s.result.hands[p.id] || [];
      const note = p.id === s.result.winnerId ? (over ? 'Won the game 👑' : 'Won this round 🏆') : left.length ? `${left.length} card${left.length > 1 ? 's' : ''} left` : '';
      return `<li class="${p.id === s.result.winnerId ? 'win' : ''}">
        <span class="rank">${i + 1}</span><span class="av">${esc(p.avatar)}</span>
        <span class="nm">${esc(p.name)}${p.id === s.me ? ' (you)' : ''}<small>${note}</small>
          ${left.length ? `<span class="left">${left.map(c => cardHTML(c)).join('')}</span>` : ''}</span>
        <span class="pts">${p.score}${s.target ? `<small> / ${s.target}</small>` : ' pts'}</span></li>`;
    }).join('');
    const host = s.players.find(p => p.id === s.hostId);
    $('#result-actions').innerHTML = s.hostId === s.me
      ? `<button class="btn big primary" data-act="next">${over ? '🔁 New game' : '▶ Next round'}</button><button class="btn ghost" data-act="lobby">Back to lobby${over ? '' : ' (resets scores)'}</button>`
      : `<p class="hint">⏳ Waiting for ${esc(host ? host.name : 'the host')} to start ${over ? 'a new game' : 'the next round'}…</p><button class="btn ghost" data-act="leave">Leave room</button>`;
  }

  function confetti(count) {
    if (reducedMotion) return;
    const c = $('#confetti');
    const ctx = c.getContext('2d');
    const dpr = devicePixelRatio || 1;
    c.width = innerWidth * dpr;
    c.height = innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const colors = [...Object.values(HEX), '#ffffff'];
    const parts = Array.from({ length: count }, () => ({
      x: innerWidth / 2 + (Math.random() - 0.5) * 240,
      y: innerHeight * 0.4,
      vx: (Math.random() - 0.5) * 16,
      vy: -Math.random() * 15 - 5,
      w: 6 + Math.random() * 6,
      h: 9 + Math.random() * 8,
      r: Math.random() * 6,
      vr: (Math.random() - 0.5) * 0.35,
      color: colors[Math.floor(Math.random() * colors.length)],
    }));
    const start = performance.now();
    (function frame(now) {
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      for (const p of parts) {
        p.vy += 0.35;
        p.vx *= 0.99;
        p.x += p.vx;
        p.y += p.vy;
        p.r += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.r);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (now - start < 4200) requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, innerWidth, innerHeight);
    })(start);
  }

  // ---------- start ----------
  initHome();
  initLobby();
  initGame();
  const urlRoom = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
  if (session && (!urlRoom || urlRoom === session.code)) {
    connect(); // same tab after a refresh
  } else {
    session = null;
    show('home');
    offerRejoin(urlRoom); // browser was closed: offer the saved seat (for this invite's room, or the latest game)
  }
  requestAnimationFrame(tick);
})();
