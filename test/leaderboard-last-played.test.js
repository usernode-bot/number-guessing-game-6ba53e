'use strict';

// Unit tests for the per-player `lastPlayed` timestamp that feeds the
// leaderboard's "last played <date>" line. lastPlayed is the player's latest
// activity in a FINISHED round (their latest guess ts, or the round's endedAt
// if they won it), derived per filter (track / difficulty) exactly like the
// rest of the playerStats object.
//
// Transactions are built the same way test/pending-guesses.test.js builds its
// seed (start_round / guess / end_round memos to APP_PUBKEY) and fed through
// the game's processTransaction.
//
// Run: `node test/leaderboard-last-played.test.js` (or `npm test`).

const assert = require('node:assert');
const { createGame } = require('../game-logic.js');

const APP_PUBKEY = 'ut1ptestapppubkeyaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaag01';
const PLAYER_A = 'utpk1playeraaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01';
const PLAYER_B = 'utpk1playerbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02';
const PLAYER_C = 'utpk1playercccccccccccccccccccccccccccccccccccccccccccccc03';

function tx(id, from, memoObj, ts) {
  return {
    id,
    from_pubkey: from,
    to: APP_PUBKEY,
    amount: 10,
    memo: JSON.stringify(memoObj),
    timestamp_ms: ts,
  };
}

function startRoundTx(id, ts, { track = '1h', difficulty = 'medium' } = {}) {
  return tx('tx-start-' + id, APP_PUBKEY, {
    app: 'numguess',
    type: 'start_round',
    round: id,
    seed_hash: '0000000' + (id % 10) + 'b'.repeat(56),
    active_duration_ms: 3600000,
    min_players: 1,
    max_guesses_per_player: 10,
    mode: 'normal',
    duration_track: track,
    difficulty,
  }, ts);
}

function guessTx(id, round, from, ts) {
  return tx('tx-guess-' + id, from, {
    app: 'numguess',
    type: 'guess',
    round,
    guess: (ts % 99) + 1,
  }, ts);
}

function endRoundTx(id, ts, winner, winnerGuess) {
  return tx('tx-end-' + id, APP_PUBKEY, {
    app: 'numguess',
    type: 'end_round',
    round: id,
    secret: 42,
    winner,
    winner_guess: winnerGuess,
    pot: 30,
    participants: 2,
  }, ts);
}

// Fixtures, as the Tests table describes:
//   round 1 — medium, 1h:  A guesses @1000, B guesses @2000; A wins; ends @5000
//   round 2 — medium, 1d:  A guesses @10000, C guesses @10500; C wins; ends @12000
//   round 3 — medium, 1h:  A guesses @20000; never ends (still active)
function buildGame(opts) {
  const game = createGame(Object.assign({ appPubkey: APP_PUBKEY }, opts));
  for (const t of [
    startRoundTx(1, 0),
    guessTx('1a', 1, PLAYER_A, 1000),
    guessTx('1b', 1, PLAYER_B, 2000),
    endRoundTx(1, 5000, PLAYER_A, 42),
    startRoundTx(2, 9000, { track: '1d' }),
    guessTx('2a', 2, PLAYER_A, 10000),
    guessTx('2c', 2, PLAYER_C, 10500),
    endRoundTx(2, 12000, PLAYER_C, 42),
    startRoundTx(3, 19000),
    guessTx('3a', 3, PLAYER_A, 20000),
  ]) game.processTransaction(t);
  return game;
}

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok  -', name); }
  catch (e) { failures++; console.error('  FAIL -', name, '\n      ', e.message); }
}

const game = buildGame();

check('difficulty stats: lastPlayed is the player’s latest guess ts across finished rounds', () => {
  const stats = game.getPlayerStatsForDifficulty('medium');
  assert.strictEqual(stats[PLAYER_A].lastPlayed, 10000);
  assert.strictEqual(stats[PLAYER_B].lastPlayed, 2000);
  assert.strictEqual(stats[PLAYER_C].lastPlayed, 12000);
});

check('winner: lastPlayed is the round’s endedAt when it is later than the guess', () => {
  // A won round 1 (guess @1000, ended @5000); per 1h track the endedAt wins.
  const stats = game.getPlayerStatsForTrack('1h');
  assert.strictEqual(stats[PLAYER_A].lastPlayed, 5000);
});

check('track stats: only that track’s finished rounds count', () => {
  const h = game.getPlayerStatsForTrack('1h');
  assert.strictEqual(h[PLAYER_A].lastPlayed, 5000);
  assert.strictEqual(h[PLAYER_B].lastPlayed, 2000);
  assert.strictEqual(h[PLAYER_C], undefined);
  const d = game.getPlayerStatsForTrack('1d');
  assert.strictEqual(d[PLAYER_A].lastPlayed, 10000);
  assert.strictEqual(d[PLAYER_C].lastPlayed, 12000);
  assert.strictEqual(d[PLAYER_B], undefined);
});

check('track+difficulty stats: same filtering as track stats', () => {
  const ht = game.getPlayerStatsForTrackAndDifficulty('1h', 'medium');
  assert.strictEqual(ht[PLAYER_A].lastPlayed, 5000);
  assert.strictEqual(ht[PLAYER_B].lastPlayed, 2000);
  const dt = game.getPlayerStatsForTrackAndDifficulty('1d', 'medium');
  assert.strictEqual(dt[PLAYER_A].lastPlayed, 10000);
});

check('a guess in a still-active round does not move lastPlayed', () => {
  // A guessed @20000 in the never-ended 1h round 3; 1h lastPlayed stays 5000.
  const stats = game.getPlayerStatsForTrack('1h');
  assert.strictEqual(stats[PLAYER_A].lastPlayed, 5000);
});

check('lastPlayed is null for a guesser whose finished-round guess has no timestamp', () => {
  // Seed-style data: the guess carries no ts (0), so the guesser who never
  // won gets lastPlayed null — not 0 / the 1970 epoch. (A round itself ending
  // at ts 0 is skipped wholesale by the existing !r.endedAt guard.)
  const game2 = createGame({ appPubkey: APP_PUBKEY });
  game2.processTransaction(tx('s0', APP_PUBKEY, { app: 'numguess', type: 'start_round', round: 9, seed_hash: '00000009' + 'b'.repeat(56), active_duration_ms: 3600000, mode: 'normal', duration_track: '1h', difficulty: 'medium' }, 0));
  game2.processTransaction(tx('g0', PLAYER_B, { app: 'numguess', type: 'guess', round: 9, guess: 7 }, 0));
  game2.processTransaction(tx('g1', PLAYER_C, { app: 'numguess', type: 'guess', round: 9, guess: 41 }, 500));
  game2.processTransaction(tx('e0', APP_PUBKEY, { app: 'numguess', type: 'end_round', round: 9, secret: 41, winner: PLAYER_C, winner_guess: 41, pot: 20, participants: 2 }, 1000));
  const stats = game2.getPlayerStatsForTrack('1h');
  assert.strictEqual(stats[PLAYER_B].lastPlayed, null);
  assert.strictEqual(stats[PLAYER_C].lastPlayed, 1000);
});

check('hidden player (opts.isHidden) is absent from stats, lastPlayed included', () => {
  const hidden = buildGame({ isHidden: (pk) => pk === PLAYER_B });
  const stats = hidden.getPlayerStatsForDifficulty('medium');
  assert.strictEqual(stats[PLAYER_B], undefined);
  assert.strictEqual(stats[PLAYER_A].lastPlayed, 10000);
});

if (failures) {
  console.error(`\n${failures} last-played test(s) failed.`);
  process.exit(1);
}
console.log('\nAll leaderboard last-played tests passed.');
