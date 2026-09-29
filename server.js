'use strict';
// UNO Party server: static files, rooms, live updates (Server-Sent Events), bots and turn timers.
// No npm packages needed. Run: node server.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Room, MAX_PLAYERS } = require('./uno');

const PORT = Number(process.env.PORT) || 4000;
const PUBLIC = path.join(__dirname, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const REACTIONS = ['😂', '😡', '😱', '🔥', '👏', '😎', '🥶', '💀', '🙏', '🤡'];
const NO_MOVES_DELAY = 1400;   // pause before drawing for someone with no playable card
const AWAY_DELAY = 15000;      // with the timer off, how long before an away player is played for
const IDLE_ROOM_MS = 60 * 60 * 1000; // rooms with nobody connected are kept this long so people can rejoin

const tables = new Map(); // code -> { room, streams: Map<pid, Set<res>>, timers, emptySince }

// ---------- helpers ----------
function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do c = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join('');
  while (tables.has(c));
  return c;
}

const cleanName = s => String(s || '').replace(/[<>&"]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16) || 'Player';
const cleanAvatar = s => (typeof s === 'string' && s.length > 0 && s.length <= 8 ? s : '😎');

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 10000) req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

// Real Wi-Fi/Ethernet addresses only: virtual adapters (WSL, Docker, VMs) can't be reached by friends.
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/vethernet|wsl|virtual|vmware|vbox|hyper-v|docker|loopback/i.test(name)) continue;
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

// ---------- live updates ----------
function broadcast(t) {
  const { room } = t;
  for (const [pid, set] of t.streams) {
    const data = `data: ${JSON.stringify(room.view(pid))}\n\n`;
    for (const res of set) res.write(data);
  }
  t.active = Date.now();
  schedule(t);
}

function sendAll(t, event, payload) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const set of t.streams.values()) for (const res of set) res.write(data);
}

// After every change: decide who moves next and when (bots, empty hands, the turn timer).
function schedule(t) {
  const { room } = t;
  clearTimeout(t.turnTimer);
  clearTimeout(t.unoTimer);
  t.turnTimer = t.unoTimer = null;
  // Nobody watching: pause the game so it's waiting when people rejoin.
  if (room.status !== 'playing' || !t.streams.size) return;
  const now = Date.now();

  const v = room.unoVulnerable;
  if (v) {
    t.unoTimer = setTimeout(() => {
      if (room.unoVulnerable === v) { room.unoVulnerable = null; broadcast(t); }
    }, Math.max(0, v.until - now) + 30);
    if (t.catchPlannedFor !== v) {
      t.catchPlannedFor = v;
      planBotCatches(t, v);
    }
  }

  const cur = room.current();
  let delay;
  let run;
  if (cur.bot) {
    // Give people a moment to hit "Catch!" before a bot moves on.
    delay = 900 + Math.random() * 900 + (v && v.pid !== cur.id ? 1500 : 0);
    run = () => { for (const a of room.botMoves(cur)) room.act(cur, a); };
  } else if (!room.playableIds(cur).length) {
    delay = NO_MOVES_DELAY;
    run = () => room.autoMove(cur, 'noMoves');
  } else if (room.turnDeadline) {
    delay = room.turnDeadline - now;
    run = () => room.autoMove(cur, 'timeout');
  } else if (!cur.connected) {
    delay = AWAY_DELAY;
    run = () => {
      room.event('auto', { pid: cur.id, reason: 'away' });
      for (const a of room.botMoves(cur)) room.act(cur, a);
    };
  } else {
    return;
  }
  const seq = room.turnSeq;
  t.turnTimer = setTimeout(() => {
    if (room.status !== 'playing' || room.current() !== cur || room.turnSeq !== seq) return;
    run();
    broadcast(t);
  }, Math.max(0, delay));
}

function planBotCatches(t, v) {
  const { room } = t;
  for (const b of room.players) {
    if (!b.bot || b.id === v.pid || Math.random() > 0.35) continue;
    setTimeout(() => {
      if (room.unoVulnerable !== v || !room.players.includes(b)) return;
      if (!room.act(b, { type: 'catch', target: v.pid })) broadcast(t);
    }, 1600 + Math.random() * 2200);
  }
}

// A room is finished once nobody left in it could ever come back.
const abandoned = room => !room.players.some(p => p.token);

function deleteTable(t) {
  clearTimeout(t.turnTimer);
  clearTimeout(t.unoTimer);
  for (const set of t.streams.values()) {
    for (const res of set) { res.write('event: gone\ndata: {}\n\n'); res.end(); }
  }
  tables.delete(t.room.code);
}

function leave(t, p) {
  const { room } = t;
  if (room.status === 'playing') room.replaceWithBot(p);
  else room.removePlayer(p.id);
  const set = t.streams.get(p.id);
  if (set) for (const res of set) res.end();
  t.streams.delete(p.id);
  if (!t.streams.size) t.emptySince = Date.now();
  if (abandoned(room)) return deleteTable(t);
  broadcast(t);
}

function openStream(req, res, url) {
  const t = tables.get(String(url.searchParams.get('code') || '').toUpperCase());
  const p = t && t.room.byToken(url.searchParams.get('token'));
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (!p) {
    res.write('event: gone\ndata: {}\n\n');
    return res.end();
  }
  res.write('retry: 2000\n\n');
  const { room } = t;
  const wasEmpty = !t.streams.size;
  let set = t.streams.get(p.id);
  if (!set) t.streams.set(p.id, (set = new Set()));
  set.add(res);
  t.emptySince = null;
  room.reconnect(p); // also takes the seat back from a stand-in computer
  if (wasEmpty) room.restartTurnTimer();
  broadcast(t);

  req.on('close', () => {
    set.delete(res);
    if (set.size || t.streams.get(p.id) !== set) return;
    t.streams.delete(p.id);
    if (!t.streams.size) t.emptySince = Date.now();
    if (!room.players.includes(p) || !tables.has(room.code)) return;
    room.disconnect(p);
    broadcast(t);
  });
}

// ---------- API ----------
function api(name, body, res) {
  if (name === 'create') {
    const code = makeCode();
    const room = new Room(code);
    const t = { room, streams: new Map(), active: Date.now(), emptySince: Date.now() };
    tables.set(code, t);
    const p = room.addPlayer({ name: cleanName(body.name), avatar: cleanAvatar(body.avatar) });
    return json(res, 200, { code, token: p.token, id: p.id });
  }

  const t = tables.get(String(body.code || '').trim().toUpperCase());
  if (!t) return json(res, 404, { error: "We couldn't find that room. Check the code and try again." });
  const { room } = t;

  if (name === 'join') {
    if (room.status === 'playing') return json(res, 409, { error: 'That room is in the middle of a round. Try again when the round ends.' });
    if (room.players.length >= MAX_PLAYERS) return json(res, 409, { error: `That room is full (${MAX_PLAYERS} players).` });
    const p = room.addPlayer({ name: cleanName(body.name), avatar: cleanAvatar(body.avatar) });
    broadcast(t);
    return json(res, 200, { code: room.code, token: p.token, id: p.id });
  }

  const p = room.byToken(String(body.token || ''));
  if (!p) return json(res, 403, { error: "You're not in this room anymore." });

  // Is a seat saved in someone's browser still here? Used for the "Rejoin" button.
  if (name === 'seat') {
    return json(res, 200, { status: room.status, round: room.round, name: p.name, avatar: p.avatar, cards: p.hand.length, score: p.score });
  }
  if (name === 'leave') {
    leave(t, p);
    return json(res, 200, { ok: true });
  }
  if (name === 'react') {
    const now = Date.now();
    if (!REACTIONS.includes(body.emoji) || now - (p.lastReact || 0) < 600) return json(res, 200, { ok: false });
    p.lastReact = now;
    sendAll(t, 'react', { pid: p.id, emoji: body.emoji });
    return json(res, 200, { ok: true });
  }
  if (name === 'action') {
    const error = room.act(p, body);
    if (error) return json(res, 400, { error });
    broadcast(t);
    return json(res, 200, { ok: true });
  }
  json(res, 404, { error: 'Unknown request.' });
}

function serveStatic(pathname, res) {
  let rel;
  try { rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, ''); } catch { rel = ''; }
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/events') return openStream(req, res, url);
    if (req.method === 'GET' && url.pathname === '/api/info') return json(res, 200, { lan: lanAddresses(), port: PORT });
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) return api(url.pathname.slice(5), await readBody(req), res);
    if (req.method === 'GET') return serveStatic(url.pathname, res);
    json(res, 405, { error: 'Not allowed.' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'Something went wrong on the server.' });
  }
});

// Keep connections open through proxies, and clean up empty rooms.
setInterval(() => {
  for (const t of tables.values()) for (const set of t.streams.values()) for (const res of set) res.write(': ping\n\n');
}, 20000);
setInterval(() => {
  const now = Date.now();
  for (const t of [...tables.values()]) {
    if (!t.streams.size && t.emptySince && now - t.emptySince > IDLE_ROOM_MS) deleteTable(t);
    else if (t.room.sweepAway(now)) {
      if (abandoned(t.room)) deleteTable(t);
      else broadcast(t);
    }
  }
}, 5000);

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use. Close the other program, or pick another port:\n  PowerShell: $env:PORT=4001; npm start\n`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, () => {
  console.log('\n  🎉 UNO Party is running!\n');
  console.log(`  On this computer:     http://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  Friends on your Wi-Fi: http://${ip}:${PORT}`);
  console.log('\n  Press Ctrl+C to stop.\n');
});
