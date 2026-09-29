'use strict';
// How long does a whole game last? Plays thousands of games to the target score (GAME_TARGETS in uno.js)
// and times every turn with a model of how people play in the app.
//   npm run simulate                  people take about 5 s to choose a card
//   npm run simulate -- --think 8     slower players
//   npm run simulate -- --games 500   quicker run
const { Room, goalFor } = require('./uno');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 1 && Number(process.argv[i + 1]) > 0 ? Number(process.argv[i + 1]) : fallback;
};
const THINK = Math.max(2, arg('--think', 5)); // average seconds a person takes to choose a card
const GAMES = arg('--games', 6000);           // games per player count (single games vary a lot, so fewer = noisier)
const TIMER = 20;                              // default turn timer (seconds)
const AUTO_DRAW = 1.4;                         // server.js NO_MOVES_DELAY: pause before drawing for you
const ANIMATION = 0.5;                         // card flying + network
const BETWEEN_ROUNDS = 12;                     // results screen, host taps Next round, new deal

// Seconds one step of a turn takes, measured before the move is made.
function stepSeconds(r, p, moves) {
  if (!p.hand.some(c => r.canPlay(c))) return AUTO_DRAW + ANIMATION; // the game draws (or takes a stack) for you
  // Thinking: at least 2 s, THINK on average, never past the timer.
  let t = Math.min(TIMER, 2 - Math.log(1 - Math.random()) * (THINK - 2));
  const play = moves.find(m => m.type === 'play');
  if (play && p.hand.find(c => c.id === play.cardId).color === 'wild') t += 1.5; // picking a color
  return t + ANIMATION;
}

function playGame(n) {
  const r = new Room('SIM');
  for (let i = 0; i < n; i++) r.addBot();
  r.newGame();
  let seconds = 0;
  for (;;) {
    r.newRound();
    while (r.status === 'playing') {
      const p = r.current();
      const moves = r.botMoves(p);
      seconds += stepSeconds(r, p, moves);
      for (const a of moves) r.act(p, a);
    }
    if (r.result.gameOver) return { minutes: seconds / 60, rounds: r.round };
    seconds += BETWEEN_ROUNDS;
  }
}

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const at = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const pad = (s, w) => String(s).padEnd(w);

console.log(`\nHow long is a game of UNO Party?`);
console.log(`${GAMES} games per size · people take ~${THINK} s per turn · ${TIMER} s timer · ${BETWEEN_ROUNDS} s between rounds\n`);
// Goals: 2 players average 10-15 min, and each extra player adds 3-5 min on top.
console.log(pad('Players', 9) + pad('First to', 10) + pad('Average', 11) + pad('Extra vs one less', 19) + pad('Middle 80% of games', 21) + 'Rounds');
let ok = true;
let prev = null;
for (let n = 2; n <= 8; n++) {
  const games = Array.from({ length: GAMES }, () => playGame(n));
  const mins = games.map(g => g.minutes).sort((a, b) => a - b);
  const avg = mean(mins);
  const { target } = goalFor(n);
  let extra;
  if (prev === null) {
    const inside = avg >= 10 && avg <= 15;
    ok = ok && inside;
    extra = `(goal 10–15) ${inside ? '✓' : '✗'}`;
  } else {
    const step = avg - prev;
    const inside = step >= 3 && step <= 5;
    ok = ok && inside;
    extra = `+${step.toFixed(1)} min ${inside ? '✓' : '✗'}`;
  }
  prev = avg;
  console.log(
    pad(n, 9) + pad(target, 10) + pad(`${avg.toFixed(1)} min`, 11) + pad(extra, 19)
    + pad(`${Math.round(at(mins, 0.1))}–${Math.round(at(mins, 0.9))} min`, 21)
    + mean(games.map(g => g.rounds)).toFixed(1),
  );
}
console.log(ok
  ? '\nOn target: 2 players average 10–15 min, and each extra player adds 3–5 min.\n'
  : '\nOff target somewhere (✗). Adjust GAME_TARGETS in uno.js, unless this is a --think run.\n');
if (!ok && THINK === 5) process.exitCode = 1;
