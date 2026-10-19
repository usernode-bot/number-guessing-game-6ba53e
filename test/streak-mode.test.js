'use strict';

// Tests for streak mode — the fifth track ('streak'): consecutive-win
// tracking with a loss/timeout reset, and a ladder that raises difficulty
// (wider range, tighter guess budget) as the hottest streak at the table
// grows.
//
// Part 1 drives a standalone game instance (createGame) with injected
// on-chain transactions, asserting the fold rules and tier mapping directly.
// Part 2 boots server.js inertly (no DB, no on-chain signer), injects the
// staging seeds, and asserts the state payload plus the set-mode refusal
// over HTTP with a properly signed RS256 iframe token.
//
// Run: `node test/streak-mode.test.js` (or `npm test`).

const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

// Server env must be set BEFORE requiring server.js: the JWT public key,
// app id, and staging flag are all snapshotted at module load. A throwaway
// RSA keypair stands in for the platform key so we can sign real tokens.
delete process.env.DATABASE_URL;
delete process.env.APP_SECRET_KEY;
process.env.USERNODE_ENV = 'staging';
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
process.env.USERNODE_JWT_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' });
process.env.USERNODE_APP_ID = '999777';

const {
  createGame,
  DIFFICULTIES,
  computeRoundScore,
  STREAK_LADDER,
  streakTierFor,
} = require('../game-logic');
const srv = require('../server.js');

const APP_PUBKEY = process.env.APP_PUBKEY || 'ut1p0p7y8ujacndc60r4a7pzk45dufdtarp6satvc0md7866633u8sqagm3az';
const P1 = 'utpk1streaktest0000000000000000000000000000000000000000000000p1';
const P2 = 'utpk1streaktest0000000000000000000000000000000000000000000000p2';
const P3 = 'utpk1streaktest0000000000000000000000000000000000000000000000p3';
const HIDDEN = 'utpk1streaktest00000000000000000000000000000000000000000000hidden';

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok  -', name); }
  catch (e) { failures++; console.error('  FAIL -', name, '\n      ', e.message); }
}

// Build a deterministic completed round inside `game` from raw tx lines, the
// same memo shapes the on-chain stream carries. `secret` is derived from the
// seed hash the same way the game derives it.
function playRound(game, opts) {
  // Each call advances the clock so the fold sees rounds in chronological
  // order (getTrackStreaks sorts by endedAt).
  if (!playRound.t) playRound.t = 1000;
  playRound.t += 100000;
  const t0 = playRound.t;
  const { id, track, difficulty, maxGuesses, guesses, secret, winner, winnerGuess, ended, tier, tierName } = opts;
  const memo = {
    app: 'numguess', type: 'start_round', round: id,
    seed_hash: '0000002a' + '5'.repeat(56),
    active_duration_ms: 900000, min_players: 1,
    max_guesses_per_player: maxGuesses || 10,
    mode: 'normal', duration_track: track, difficulty,
  };
  if (tier != null) { memo.streak_tier = tier; memo.streak_tier_name = tierName; }
  game.processTransaction({ id: 's-' + id, to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify(memo), timestamp_ms: t0 });
  let ts = t0 + 100;
  for (const g of guesses) {
    game.processTransaction({ id: 'g-' + id + '-' + g[0] + '-' + g[1] + '-' + ts, to: APP_PUBKEY, from_pubkey: g[0], amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: id, guess: g[1] }), timestamp_ms: ts });
    ts += 10;
  }
  if (ended !== false) {
    game.processTransaction({ id: 'e-' + id, to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'end_round', round: id, secret, winner: winner || null, winner_guess: winnerGuess, pot: guesses.length, participants: new Set(guesses.map((g) => g[0])).size }), timestamp_ms: ts });
  }
}

// ---------------------------------------------------------------------------
// Part 1 — tier mapping, score override, and the fold
// ---------------------------------------------------------------------------

check('ladder shape: four rungs with the documented thresholds', () => {
  assert.strictEqual(STREAK_LADDER.length, 4);
  assert.deepStrictEqual(STREAK_LADDER.map((r) => r.minStreak), [0, 2, 4, 7]);
  assert.deepStrictEqual(STREAK_LADDER.map((r) => r.name), ['Warming up', 'On a roll', 'Blazing', 'Inferno']);
  assert.strictEqual(STREAK_LADDER[0].difficulty, 'medium');
  assert.strictEqual(STREAK_LADDER[1].difficulty, 'hard');
  assert.strictEqual(STREAK_LADDER[2].maxGuesses, 7);
  assert.strictEqual(STREAK_LADDER[3].maxGuesses, 3);
});

check('streakTierFor maps 0–1 → Warming up, 2–3 → On a roll, 4–6 → Blazing, 7+ → Inferno', () => {
  assert.strictEqual(streakTierFor(0).tier, 0);
  assert.strictEqual(streakTierFor(1).tier, 0);
  assert.strictEqual(streakTierFor(2).tier, 1);
  assert.strictEqual(streakTierFor(3).tier, 1);
  assert.strictEqual(streakTierFor(4).tier, 2);
  assert.strictEqual(streakTierFor(6).tier, 2);
  assert.strictEqual(streakTierFor(7).tier, 3);
  assert.strictEqual(streakTierFor(20).tier, 3);
  assert.strictEqual(streakTierFor(3).name, 'On a roll');
  assert.strictEqual(streakTierFor(5).maxGuesses, 7);
});

check('computeRoundScore honors the maxGuesses override (Blazing reuses hard with 7)', () => {
  // Without the override the hard budget (15) would give 1000 × 6; with the
  // Blazing budget (7) it must be 1000 × max(1, 7 − 2 + 1) = 6000.
  assert.strictEqual(computeRoundScore('hard', 2, true, null, 7), 6000);
  assert.strictEqual(computeRoundScore('hard', 2, true, null), 1000 * Math.max(1, DIFFICULTIES.hard.maxGuesses - 2 + 1));
  // Inferno: hard, budget 3.
  assert.strictEqual(computeRoundScore('hard', 2, true, null, 3), 2000);
  // No override on a classic round → unchanged historical score.
  assert.strictEqual(computeRoundScore('medium', 3, true, null), 300 * 8);
  // Losses still score 0 and a bullseye still doubles.
  assert.strictEqual(computeRoundScore('hard', 2, false, null, 3), 0);
  assert.strictEqual(computeRoundScore('hard', 3, true, 0, 3), 2000);
});

check('two consecutive wins → currentStreak 2, bestStreak 2; other participants reset', () => {
  const game = createGame({ appPubkey: APP_PUBKEY });
  playRound(game, { id: 1, track: 'streak', difficulty: 'medium', guesses: [[P1, 1], [P2, 2]], secret: 1, winner: P1, winnerGuess: 1 });
  playRound(game, { id: 2, track: 'streak', difficulty: 'medium', guesses: [[P1, 3], [P2, 4]], secret: 3, winner: P1, winnerGuess: 3 });
  const s = game.getTrackStreaks('streak');
  assert.strictEqual(s[P1].currentStreak, 2);
  assert.strictEqual(s[P1].bestStreak, 2);
  assert.strictEqual(s[P2].currentStreak, 0);
  assert.strictEqual(game.getStreakChampionStreak(), 2);
});

check('a loss after a win resets the streak (winner +1, others → 0)', () => {
  const game = createGame({ appPubkey: APP_PUBKEY });
  playRound(game, { id: 1, track: 'streak', difficulty: 'medium', guesses: [[P1, 1], [P2, 2]], secret: 1, winner: P1, winnerGuess: 1 });
  playRound(game, { id: 2, track: 'streak', difficulty: 'medium', guesses: [[P1, 5], [P2, 6]], secret: 6, winner: P2, winnerGuess: 6 });
  const s = game.getTrackStreaks('streak');
  assert.strictEqual(s[P1].currentStreak, 0);
  assert.strictEqual(s[P1].bestStreak, 1); // best is the running max
  assert.strictEqual(s[P2].currentStreak, 1);
});

check('a winnerless streak round (timeout) resets its participants; 1h does not', () => {
  const game = createGame({ appPubkey: APP_PUBKEY });
  playRound(game, { id: 1, track: 'streak', difficulty: 'medium', guesses: [[P1, 1], [P2, 2]], secret: 1, winner: P1, winnerGuess: 1 });
  playRound(game, { id: 2, track: 'streak', difficulty: 'medium', guesses: [[P1, 5], [P2, 6], [P3, 7]], secret: 9, ended: true, winner: null });
  let s = game.getTrackStreaks('streak');
  assert.strictEqual(s[P1].currentStreak, 0, 'streak participant reset by timeout');
  assert.strictEqual(s[P2].currentStreak, 0, 'streak participant reset by timeout');
  assert.deepStrictEqual(s[P3], { currentStreak: 0, bestStreak: 0 }, 'a non-winning participant only drops to 0, never gains');

  const g2 = createGame({ appPubkey: APP_PUBKEY });
  playRound(g2, { id: 1, track: '1h', difficulty: 'medium', guesses: [[P1, 1], [P2, 2]], secret: 1, winner: P1, winnerGuess: 1 });
  playRound(g2, { id: 2, track: '1h', difficulty: 'medium', guesses: [[P1, 5], [P2, 6]], secret: 9, ended: true, winner: null });
  s = g2.getTrackStreaks('1h');
  assert.strictEqual(s[P1].currentStreak, 1, 'winnerless rounds leave other tracks untouched');
});

check('a hidden winner earns no credit and counts as a winnerless streak round', () => {
  const game = createGame({
    appPubkey: APP_PUBKEY,
    isHidden: (pk) => pk === HIDDEN,
  });
  playRound(game, { id: 1, track: 'streak', difficulty: 'medium', guesses: [[P1, 1], [P2, 2]], secret: 1, winner: P1, winnerGuess: 1 });
  playRound(game, { id: 2, track: 'streak', difficulty: 'medium', guesses: [[P1, 5], [HIDDEN, 6]], secret: 6, winner: HIDDEN, winnerGuess: 6 });
  const s = game.getTrackStreaks('streak');
  assert.strictEqual(s[HIDDEN], undefined, 'hidden winner earns no streak');
  assert.strictEqual(s[P1].currentStreak, 0, 'streak track: a hidden-winner round resets its visible participants');
  assert.strictEqual(s[P1].bestStreak, 1, 'best streak keeps the running max');
  assert.strictEqual(game.getStreakChampionStreak(), 0, 'champion streak ignores hidden players');
});

check('getMyStreaks includes the streak track (defaulting to 0/0)', () => {
  const game = createGame({ appPubkey: APP_PUBKEY });
  const s = game.getMyStreaks(P1);
  assert.deepStrictEqual(Object.keys(s).sort(), ['1d', '1h', '1w', '6h', 'streak']);
  assert.deepStrictEqual(s.streak, { currentStreak: 0, bestStreak: 0 });
});

check('streak-tier fields ride on the round object from the start_round memo', () => {
  const game = createGame({ appPubkey: APP_PUBKEY });
  playRound(game, { id: 1, track: 'streak', difficulty: 'hard', maxGuesses: 15, guesses: [[P1, 1]], tier: 1, tierName: 'On a roll', ended: false });
  playRound(game, { id: 2, track: '1h', difficulty: 'medium', guesses: [[P1, 1]], ended: false });
  const state = game.getStateResponse();
  const st = state.tracks.streak.currentRound;
  assert.strictEqual(st.streakTier, 1);
  assert.strictEqual(st.streakTierName, 'On a roll');
  assert.strictEqual(state.tracks['1h'].currentRound.streakTier, null);
});

// ---------------------------------------------------------------------------
// Part 2 — server integration: staging seeds, state payload, set-mode refusal
// ---------------------------------------------------------------------------

(async () => {
  const P1_SEED = 'utpk1stagingplayer000000000000000000000000000000000000000001';
  const P2_SEED = 'utpk1stagingplayer000000000000000000000000000000000000000002';

  const server = http.createServer(srv.app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  function request(method, path, { body, auth } = {}) {
    return new Promise((resolve, reject) => {
      const { port } = server.address();
      const payload = body != null ? JSON.stringify(body) : null;
      const headers = {};
      if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(payload); }
      if (auth) headers['x-usernode-token'] = auth;
      const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch { /* leave null */ }
          resolve({ status: res.statusCode, json });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  function signToken() {
    return jwt.sign(
      { id: 'streak-test-user', username: 'streak_s', usernode_pubkey: P1, pur: 'iframe' },
      privateKey,
      { algorithm: 'RS256', expiresIn: '5m', issuer: 'usernode', audience: 'usernode:app:' + process.env.USERNODE_APP_ID },
    );
  }

  try {
    // injectStagingSeeds() feeds rounds 80/81/82 (streak) through the same
    // ingest path as real chain txs.
    srv.injectStagingSeeds();

    // The hide-the-unnamed predicate reads a snapshot refreshed by public
    // reads; /__numguess/state short-circuits to a loading payload while the
    // tx stream never started in this inert boot, so sync through the
    // usernames endpoint (which always refreshes the snapshot).
    const unamesRes = await request('GET', '/__usernames/state');
    assert.strictEqual(unamesRes.status, 200);
    assert.ok(unamesRes.json && unamesRes.json.usernames, 'usernames endpoint returns the directory map');

    const s = srv.game.getTrackStreaks('streak');
    await (async () => {
      try {
        assert.strictEqual(s[P1_SEED].currentStreak, 2, 'alice_s won rounds 80 and 81 back to back');
        assert.strictEqual(s[P1_SEED].bestStreak, 2);
        assert.strictEqual(s[P2_SEED].currentStreak, 0, 'losers reset to 0');
        console.log('  ok  - staging seeds: p1 folds to streak 2, p2 reset to 0');
      } catch (e) { failures++; console.error('  FAIL - staging seeds: p1 folds to streak 2, p2 reset to 0\n      ', e.message); }
    })();

    const state = srv.game.getStateResponse();
    await (async () => {
      try {
        const st = state.tracks.streak;
        assert.ok(st, 'state exposes the streak track');
        const cur = st.currentRound;
        assert.ok(cur, 'streak track has an active seeded round (82)');
        assert.strictEqual(cur.streakTier, 1);
        assert.strictEqual(cur.streakTierName, 'On a roll');
        assert.strictEqual(cur.difficulty, 'hard');
        assert.strictEqual(cur.range, 1000);
        assert.strictEqual(cur.maxGuessesPerPlayer, 15);
        assert.strictEqual(cur.activeDurationMs, 900000);
        console.log('  ok  - state: streak round 82 is tier 1 / hard / 1–1000 / 15 guesses');
      } catch (e) { failures++; console.error('  FAIL - state: streak round 82 is tier 1 / hard / 1–1000 / 15 guesses\n      ', e.message); }
    })();

    await (async () => {
      try {
        const mine = srv.game.getMyStreaks(P1_SEED);
        assert.ok('streak' in mine, 'myStreaks payload carries the streak key');
        assert.strictEqual(mine.streak.currentStreak, 2);
        console.log('  ok  - getMyStreaks includes the streak track for the seeded winner');
      } catch (e) { failures++; console.error('  FAIL - getMyStreaks includes the streak track for the seeded winner\n      ', e.message); }
    })();

    const token = signToken();
    await (async () => {
      try {
        const res = await request('POST', '/__numguess/admin/set-mode', { body: { track: 'streak', difficulty: 'hard' }, auth: token });
        assert.strictEqual(res.status, 400);
        assert.match(res.json && res.json.error, /Streak track difficulty is automatic/);
        console.log('  ok  - set-mode on the streak track is refused (400, automatic difficulty)');
      } catch (e) { failures++; console.error('  FAIL - set-mode on the streak track is refused (400, automatic difficulty)\n      ', e.message); }
    })();

    await (async () => {
      try {
        // A classic track still accepts set-mode — the refusal is streak-only.
        const res = await request('POST', '/__numguess/admin/set-mode', { body: { track: '1h', difficulty: 'easy' }, auth: token });
        assert.strictEqual(res.status, 200);
        console.log('  ok  - set-mode still works on classic tracks (1h → easy accepted)');
      } catch (e) { failures++; console.error('  FAIL - set-mode still works on classic tracks (1h → easy accepted)\n      ', e.message); }
    })();
  } finally {
    await new Promise((r) => server.close(r));
  }

  if (failures) {
    console.error(`\n${failures} streak-mode test(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll streak-mode tests passed.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
