'use strict';

const express = require('express');
const path = require('path');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');

const {
  loadEnvFile,
  handleExplorerProxy,
  createAppStateCache,
  createUsernamesCache,
  createNodeStatusProbe,
  EXPLORER_PROXY_PREFIX,
} = require('./lib/dapp-server');
const { createGame, DIFFICULTIES } = require('./game-logic');
const db = require('./lib/db');
const hidden = require('./lib/hidden-users');

loadEnvFile();

const app = express();
const port = parseInt(process.env.PORT || '3000', 10);
const JWT_SECRET = process.env.JWT_SECRET;

const APP_PUBKEY = process.env.APP_PUBKEY || 'utpk1rn7sakz2nvk2uzlvf4spzl22374z9u0jvah8yqs0djc722u96uqs20yx79';
const APP_SECRET_KEY = process.env.APP_SECRET_KEY || '';
const NODE_RPC_URL = process.env.NODE_RPC_URL || 'http://usernode-node:3000';
const TIMER_DURATION_MS = parseInt(process.env.TIMER_DURATION_MS || '86400000', 10);
const ROUND_TIMED_MS = parseInt(process.env.ROUND_TIMED_MS || '60000', 10);
const MIN_PLAYERS = parseInt(process.env.MIN_PLAYERS || '2', 10);
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

const TRACKS = ['1h', '6h', '1d', '1w'];
const TRACK_DURATIONS = {
  '1h': 3600000,
  '6h': 21600000,
  '1d': TIMER_DURATION_MS,
  '1w': 604800000,
};

// Per-track pending difficulty for next round (resets to 'medium' after each round starts)
const pendingDifficulty = { '1h': 'medium', '6h': 'medium', '1d': 'medium', '1w': 'medium' };

// Per-track payout guards
const inFlightPayout = { '1h': false, '6h': false, '1d': false, '1w': false };

// ---------------------------------------------------------------------------
// Per-user game history (Postgres-backed)
// ---------------------------------------------------------------------------
//
// Live gameplay stays on-chain; `game_results` is a durable per-user projection
// of finished rounds, recorded lazily when a signed-in player reads their
// history (see GET /api/my-history). One-shot guard so a missing/unreachable DB
// logs once instead of on every request.
let dbWarned = false;

// Staging demo identity + rows for the "My Games" tab. A real staging reviewer
// signs in as themselves, whose wallet never matches the seeded on-chain
// players, so without this their personal history would always be empty. These
// rows are obviously fake (fixed `staging-demo-user`, "alice_s" display name)
// and are surfaced read-only behind `IS_STAGING && ?demo=1`. No-op in prod.
const STAGING_DEMO_USER = { id: 'staging-demo-user', username: 'alice_s', usernode_pubkey: null };
const STAGING_DEMO_RESULTS = (() => {
  const now = Date.now();
  const hour = 3600000;
  const day = 86400000;
  return [
    { round_id: 62, track: '1d', difficulty: 'hard',   num_guesses: 10, won: true,  outcome: 'won',  best_guess: 250, best_distance: 0, secret: 250, pot: 10, ended_at: now - 2 * day },
    { round_id: 50, track: '1d', difficulty: 'easy',   num_guesses: 1,  won: true,  outcome: 'won',  best_guess: 5,   best_distance: 0, secret: 5,   pot: 3,  ended_at: now - 1 * day },
    { round_id: 8,  track: '1h', difficulty: 'medium', num_guesses: 1,  won: true,  outcome: 'won',  best_guess: 50,  best_distance: 0, secret: 50,  pot: 2,  ended_at: now - 6 * hour },
    { round_id: 23, track: '1w', difficulty: 'medium', num_guesses: 4,  won: false, outcome: 'lost', best_guess: 47,  best_distance: 2, secret: 45,  pot: 0,  ended_at: now - 3 * day },
    { round_id: 5,  track: '1h', difficulty: 'medium', num_guesses: 3,  won: false, outcome: 'lost', best_guess: 60,  best_distance: 1, secret: 61,  pot: 0,  ended_at: now - 12 * hour },
    { round_id: 12, track: '6h', difficulty: 'easy',   num_guesses: 2,  won: false, outcome: 'lost', best_guess: 8,   best_distance: 2, secret: 6,   pot: 0,  ended_at: now - 4 * hour },
  ];
})();

// Derive a single player's finished-round results from the live on-chain state.
// Mirrors the closest-to-secret logic used by findWinner / renderHistory.
function collectUserResults(pubkey) {
  if (!pubkey) return [];
  const out = [];
  for (const [, r] of game.rounds) {
    if (!r.endedAt) continue;
    const mine = r.guesses.filter((g) => g.from === pubkey);
    if (!mine.length) continue;

    const secret = r.secret != null
      ? r.secret
      : (r.seedHash ? game.computeSecret(r.seedHash, r.range) : null);

    let bestGuess = mine[0].guess;
    let bestDist = null;
    if (secret != null) {
      for (const g of mine) {
        const d = Math.abs(g.guess - secret);
        if (bestDist === null || d < bestDist) { bestDist = d; bestGuess = g.guess; }
      }
    }

    const won = r.winner === pubkey;
    const outcome = won ? 'won' : (r.winner ? 'lost' : 'no_winner');
    const numGuesses = r.rawGuessCounts ? (r.rawGuessCounts[pubkey] || mine.length) : mine.length;

    out.push({
      round_id: r.id,
      track: r.durationTrack || null,
      difficulty: r.difficulty || 'medium',
      num_guesses: numGuesses,
      won,
      outcome,
      best_guess: bestGuess,
      best_distance: bestDist,
      secret,
      pot: won ? (r.pot != null ? r.pot : 0) : 0,
      ended_at: r.endedAt || null,
    });
  }
  out.sort((a, b) => (b.ended_at || 0) - (a.ended_at || 0) || b.round_id - a.round_id);
  return out;
}

function computeHistoryStats(results) {
  const played = results.length;
  const wins = results.filter((r) => r.won).length;
  const winRate = played ? Math.round((wins / played) * 100) : 0;
  return { played, wins, winRate };
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

const PUBLIC_API_PATHS = new Set(['/health', '/__numguess/state', '/favicon.ico']);
const PUBLIC_PREFIXES = [
  EXPLORER_PROXY_PREFIX,
  '/__usernode/',
  '/__usernames/',
  '/usernode-loading.js',
  '/usernode-usernames.js',
];

app.use(express.json());

app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  // Coarse reason the credential didn't resolve, consumed by the shell gate
  // page and by gated 401 responses. Never logs the raw token.
  //   'missing'  — no token supplied (likely opened outside Usernode)
  //   'no_secret'— JWT_SECRET not configured on the server (misconfiguration)
  //   'expired'  — token present but past its exp
  //   'invalid'  — token present but signature/format rejected
  if (!token) {
    req.authError = 'missing';
  } else if (!JWT_SECRET) {
    req.authError = 'no_secret';
    console.error('[auth] token present but JWT_SECRET is not configured — cannot verify sessions');
  } else {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      req.authError = err && err.name === 'TokenExpiredError' ? 'expired' : 'invalid';
      console.warn(`[auth] token verification failed: ${req.authError} (${err && err.name})`);
    }
  }
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) return next();
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated', reason: req.authError || 'missing' });
    }
  }
  next();
});

// ---------------------------------------------------------------------------
// Game setup
// ---------------------------------------------------------------------------

// Snapshot of the live usernames directory (pubkey -> custom name), refreshed
// by syncHiddenFromUsernames() before every public state read. The hide
// predicate closes over this rather than rebuilding it per pubkey.
let usernameMapCache = Object.create(null);

// A player is hidden from every public view when EITHER:
//   - they are on the explicit block-list (e.g. user_vedge), OR
//   - they have NOT set a real Usernode username — i.e. their pubkey is absent
//     from the usernames directory, so their name would only ever be the
//     auto-generated `user_<last6>` fallback.
// Only players with a real, custom-set username appear anywhere others can see.
function isHiddenFromPublic(pubkey) {
  if (hidden.isHiddenPubkey(pubkey)) return true;
  return !usernameMapCache[pubkey];
}

const game = createGame({
  appPubkey: APP_PUBKEY,
  timerDurationMs: TIMER_DURATION_MS,
  minPlayers: MIN_PLAYERS,
  // Filter blocked + unnamed players out of all chain-derived public state.
  isHidden: isHiddenFromPublic,
});

// Refresh the usernames snapshot and resolve any hide-by-username entries to
// their pubkeys. Cheap + idempotent; called before each public state read so it
// self-heals as set_username txs land. Returns the pubkey -> name map.
function syncHiddenFromUsernames() {
  const map = (usernamesCache.getStateResponse() || {}).usernames || {};
  usernameMapCache = map;
  hidden.resolveHiddenFromUsernameMap(map);
  return map;
}

const numguessCache = createAppStateCache({
  name: 'numguess',
  appPubkey: APP_PUBKEY,
  queryField: 'recipient',
  processTransaction: game.processTransaction,
  nodeRpcUrl: NODE_RPC_URL,
});

const usernamesCache = createUsernamesCache({
  nodeRpcUrl: NODE_RPC_URL,
});

const nodeStatusProbe = createNodeStatusProbe({
  nodeRpcUrl: NODE_RPC_URL,
});

nodeStatusProbe.registerStream('numguess', () => numguessCache.isStreamReady());
nodeStatusProbe.registerStream('usernames', () => usernamesCache.isStreamReady());

// ---------------------------------------------------------------------------
// Staging seeds
// ---------------------------------------------------------------------------

function injectStagingSeeds() {
  const now = Date.now();
  const day = 86400000;
  const hour = 3600000;

  // Precomputed seed hashes where parseInt(hash.slice(0,8), 16) % 100 + 1 equals the target secret.
  // secret = 42: need x % 100 == 41. Use hex "00000029" = 41 in decimal.
  // secret = 75: need x % 100 == 74. Use hex "0000004a" = 74 in decimal.
  // secret = 23: need x % 100 == 22. Use hex "00000016" = 22 in decimal.
  // secret = 28: need x % 100 == 27. Use hex "0000007f" = 127 in decimal (127 % 100 = 27).
  // secret = 61: need x % 100 == 60. Use hex "0000003c" = 60 in decimal.
  // secret = 50: need x % 100 == 49. Use hex "00000031" = 49 in decimal.
  // secret = 33: need x % 100 == 32. Use hex "00000020" = 32 in decimal.
  // secret = 67: need x % 100 == 66. Use hex "00000042" = 66 in decimal.
  // secret = 45: need x % 100 == 44. Use hex "0000002c" = 44 in decimal.
  const seedHashes = [
    '00000029aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0001',
    '0000004abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb0002',
    '00000016cccccccccccccccccccccccccccccccccccccccccccccccccccc0003',
    '0000007fdddddddddddddddddddddddddddddddddddddddddddddddddddd0004',
    '0000003ceeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee0005',
    '00000031ffffffffffffffffffffffffffffffffffffffffffffffffffff0006',
    '00000020' + 'a'.repeat(56), // round 7, secret=33
    '00000042' + 'c'.repeat(56), // round 9, secret=67
    '0000002c' + 'd'.repeat(56), // round 10, secret=45
    // New rounds for leaderboard demonstration (rounds 20-30, 1d track, multi-guess)
    '00000100' + '1'.repeat(56), // round 20
    '00000101' + '2'.repeat(56), // round 21
    '00000102' + '3'.repeat(56), // round 22
    '00000103' + '4'.repeat(56), // round 23
    '00000104' + '5'.repeat(56), // round 24
    '00000105' + '6'.repeat(56), // round 25
    '00000106' + '7'.repeat(56), // round 26
    '00000107' + '8'.repeat(56), // round 27
    '00000108' + '9'.repeat(56), // round 28
    '00000109' + 'e'.repeat(56), // round 29
    '0000010a' + 'f'.repeat(56), // round 30
  ];

  // Active round hashes (secret doesn't matter for active rounds)
  const activeHashes = {
    r8:  '0000005a' + 'b'.repeat(56),
    r11: '00000064' + 'e'.repeat(56),
    r12: '00000077' + 'f'.repeat(56),
  };

  const p1 = 'utpk1stagingplayer000000000000000000000000000000000000000001';
  const p2 = 'utpk1stagingplayer000000000000000000000000000000000000000002';
  const p3 = 'utpk1stagingplayer000000000000000000000000000000000000000003';
  const p4 = 'utpk1stagingplayer000000000000000000000000000000000000000004';
  const p5 = 'utpk1stagingplayer000000000000000000000000000000000000000005';
  const p6 = 'utpk1stagingplayer000000000000000000000000000000000000000006';
  const p7 = 'utpk1stagingplayer000000000000000000000000000000000000000007';
  const p8 = 'utpk1stagingplayer000000000000000000000000000000000000000008';
  const p9 = 'utpk1stagingplayer000000000000000000000000000000000000000009';
  const p10 = 'utpk1stagingplayer00000000000000000000000000000000000000000a';
  const p11 = 'utpk1stagingplayer00000000000000000000000000000000000000000b';
  // p12 is "user_vedge" — the blocked player. Seeded with prominent 1-guess wins
  // so the leaderboard WOULD rank them #1; the hidden-users filter must remove
  // them. Verifies the hide end-to-end (see rounds 40/41 + username u12 below).
  const p12 = 'utpk1stagingplayer00000000000000000000000000000000000000000c';
  // p13 has NEVER set a Usernode username, so their resolved name is only the
  // auto-generated user_<last6> fallback. Seeded with a prominent 1-guess win
  // (round 42) so they WOULD top the leaderboard — but the "named players only"
  // filter must exclude them. Intentionally has no set_username seed tx.
  const p13 = 'utpk1stagingplayer00000000000000000000000000000000000000000d';

  // Round 4: TIMED + HARD MODE — 2-minute timer started 2 hours ago → already expired on boot.
  const r4StartMs = now - 2 * hour;
  const r4DurationMs = 120000;

  const fakeTxs = [
    // ---- 1D TRACK ----
    // Round 1 — 1d — secret 42 — alice_s wins with bullseye
    { id: 'staging-r1-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: 1, seed_hash: seedHashes[0], active_duration_ms: TIMER_DURATION_MS, min_players: MIN_PLAYERS, max_guesses_per_player: 1, mode: 'normal', duration_track: '1d' }), timestamp_ms: now - 2 * day - 1000 },
    { id: 'staging-r1-g1', to: APP_PUBKEY, from_pubkey: p1, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 1, guess: 42 }), timestamp_ms: now - 2 * day + 100 },
    { id: 'staging-r1-g2', to: APP_PUBKEY, from_pubkey: p2, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 1, guess: 45 }), timestamp_ms: now - 2 * day + 200 },
    { id: 'staging-r1-g3', to: APP_PUBKEY, from_pubkey: p3, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 1, guess: 38 }), timestamp_ms: now - 2 * day + 300 },
    { id: 'staging-r1-end', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'end_round', round: 1, secret: 42, winner: p1, winner_guess: 42, pot: 3, participants: 3 }), timestamp_ms: now - day - 1000 },

    // Round 2 — 1d — secret 75 — bob_s wins with guess 74
    { id: 'staging-r2-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: 2, seed_hash: seedHashes[1], active_duration_ms: TIMER_DURATION_MS, min_players: MIN_PLAYERS, max_guesses_per_player: 1, mode: 'normal', duration_track: '1d' }), timestamp_ms: now - day - 1000 },
    { id: 'staging-r2-g1', to: APP_PUBKEY, from_pubkey: p2, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 2, guess: 74 }), timestamp_ms: now - day + 100 },
    { id: 'staging-r2-g2', to: APP_PUBKEY, from_pubkey: p1, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 2, guess: 80 }), timestamp_ms: now - day + 200 },
    { id: 'staging-r2-g3', to: APP_PUBKEY, from_pubkey: p3, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 2, guess: 70 }), timestamp_ms: now - day + 300 },
    { id: 'staging-r2-end', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'end_round', round: 2, secret: 75, winner: p2, winner_guess: 74, pot: 4, participants: 4 }), timestamp_ms: now - 12 * hour - 1000 },

    // Round 3 — 1d — secret 23 — carol_s wins with guess 25
    { id: 'staging-r3-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: 3, seed_hash: seedHashes[2], active_duration_ms: TIMER_DURATION_MS, min_players: MIN_PLAYERS, max_guesses_per_player: 1, mode: 'normal', duration_track: '1d' }), timestamp_ms: now - 12 * hour - 1000 },
    { id: 'staging-r3-g1', to: APP_PUBKEY, from_pubkey: p3, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 3, guess: 25 }), timestamp_ms: now - 12 * hour + 100 },
    { id: 'staging-r3-g2', to: APP_PUBKEY, from_pubkey: p2, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 3, guess: 20 }), timestamp_ms: now - 12 * hour + 200 },
    { id: 'staging-r3-g3', to: APP_PUBKEY, from_pubkey: p1, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 3, guess: 26 }), timestamp_ms: now - 12 * hour + 300 },
    { id: 'staging-r3-end', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'end_round', round: 3, secret: 23, winner: p3, winner_guess: 25, pot: 3, participants: 3 }), timestamp_ms: now - 6 * hour },

    // Round 4 — TIMED (not part of 4 simultaneous tracks) — expired 2h ago
    { id: 'staging-r4-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: 4, seed_hash: seedHashes[3], active_duration_ms: r4DurationMs, min_players: 0, mode: 'timed', max_guesses_per_player: 5 }), timestamp_ms: r4StartMs },
    { id: 'staging-r4-g1', to: APP_PUBKEY, from_pubkey: p1, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 4, guess: 55 }), timestamp_ms: r4StartMs + 1000 },
    { id: 'staging-r4-g2', to: APP_PUBKEY, from_pubkey: p2, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 4, guess: 70 }), timestamp_ms: r4StartMs + 2000 },
    { id: 'staging-r4-g3', to: APP_PUBKEY, from_pubkey: p1, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 4, guess: 60 }), timestamp_ms: r4StartMs + 5000 },
    { id: 'staging-r4-end', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'end_round', round: 4, secret: 28, winner: p1, winner_guess: 55, pot: 3, participants: 2 }), timestamp_ms: r4StartMs + r4DurationMs + 1000 },

    // ---- 1H TRACK ----
    // Round 5 — 1h — completed (started 3h ago, ended 2h ago) — secret=61 — alice_s wins
    { id: 'staging-r5-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: 5, seed_hash: seedHashes[4], active_duration_ms: 3600000, min_players: MIN_PLAYERS, max_guesses_per_player: 10, mode: 'normal', duration_track: '1h' }), timestamp_ms: now - 3 * hour },
    { id: 'staging-r5-g1', to: APP_PUBKEY, from_pubkey: p1, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 5, guess: 60 }), timestamp_ms: now - 3 * hour + 600000 },
    { id: 'staging-r5-g2', to: APP_PUBKEY, from_pubkey: p2, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 5, guess: 65 }), timestamp_ms: now - 3 * hour + 900000 },
    { id: 'staging-r5-g3', to: APP_PUBKEY, from_pubkey: p3, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 5, guess: 55 }), timestamp_ms: now - 3 * hour + 1200000 },
    { id: 'staging-r5-end', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'end_round', round: 5, secret: 61, winner: p1, winner_guess: 60, pot: 3, participants: 3 }), timestamp_ms: now - 2 * hour },

    // Round 7 — 1h — completed (started 6h ago, ended 5h ago) — secret=33 — bob_s wins
    { id: 'staging-r7-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: 7, seed_hash: seedHashes[6], active_duration_ms: 3600000, min_players: MIN_PLAYERS, max_guesses_per_player: 10, mode: 'normal', duration_track: '1h' }), timestamp_ms: now - 6 * hour },
    { id: 'staging-r7-g1', to: APP_PUBKEY, from_pubkey: p2, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 7, guess: 34 }), timestamp_ms: now - 6 * hour + 600000 },
    { id: 'staging-r7-g2', to: APP_PUBKEY, from_pubkey: p1, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 7, guess: 30 }), timestamp_ms: now - 6 * hour + 900000 },
    { id: 'staging-r7-g3', to: APP_PUBKEY, from_pubkey: p3, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 7, guess: 28 }), timestamp_ms: now - 6 * hour + 1200000 },
    { id: 'staging-r7-end', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'end_round', round: 7, secret: 33, winner: p2, winner_guess: 34, pot: 3, participants: 3 }), timestamp_ms: now - 5 * hour },

    // Round 8 — 1h — seeded as ENDED with no active successor, so the 1h track has
    // no current round on boot. Staging then visibly auto-starts a fresh 1h round
    // (demonstrating the production auto-start fix). The other three tracks keep
    // their seeded active rounds. No-op outside staging.
    { id: 'staging-r8-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: 8, seed_hash: activeHashes.r8, active_duration_ms: 3600000, min_players: MIN_PLAYERS, max_guesses_per_player: 10, mode: 'normal', duration_track: '1h' }), timestamp_ms: now - 90 * 60000 },
    { id: 'staging-r8-g1', to: APP_PUBKEY, from_pubkey: p1, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 8, guess: 50 }), timestamp_ms: now - 85 * 60000 },
    { id: 'staging-r8-g2', to: APP_PUBKEY, from_pubkey: p3, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 8, guess: 75 }), timestamp_ms: now - 83 * 60000 },
    { id: 'staging-r8-end', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'end_round', round: 8, secret: 50, winner: p1, winner_guess: 50, pot: 2, participants: 2 }), timestamp_ms: now - 30 * 60000 },

    // ---- 1W TRACK ----
    // Round 6 — 1w — active (started 30min ago, expires in ~6d 23.5h)
    { id: 'staging-r6-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: 6, seed_hash: seedHashes[5], active_duration_ms: 604800000, min_players: MIN_PLAYERS, max_guesses_per_player: 10, mode: 'normal', duration_track: '1w' }), timestamp_ms: now - 30 * 60000 },
    { id: 'staging-r6-g1', to: APP_PUBKEY, from_pubkey: p1, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 6, guess: 33 }), timestamp_ms: now - 25 * 60000 },
    { id: 'staging-r6-g2', to: APP_PUBKEY, from_pubkey: p2, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 6, guess: 55 }), timestamp_ms: now - 20 * 60000 },
    { id: 'staging-r6-g3', to: APP_PUBKEY, from_pubkey: p3, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 6, guess: 80 }), timestamp_ms: now - 15 * 60000 },

    // ---- 6H TRACK ----
    // Round 9 — 6h — completed (started 14h ago, ended 8h ago) — secret=67 — carol_s wins
    { id: 'staging-r9-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: 9, seed_hash: seedHashes[7], active_duration_ms: 21600000, min_players: MIN_PLAYERS, max_guesses_per_player: 10, mode: 'normal', duration_track: '6h' }), timestamp_ms: now - 14 * hour },
    { id: 'staging-r9-g1', to: APP_PUBKEY, from_pubkey: p3, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 9, guess: 68 }), timestamp_ms: now - 14 * hour + hour },
    { id: 'staging-r9-g2', to: APP_PUBKEY, from_pubkey: p1, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 9, guess: 70 }), timestamp_ms: now - 14 * hour + 2 * hour },
    { id: 'staging-r9-g3', to: APP_PUBKEY, from_pubkey: p2, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 9, guess: 64 }), timestamp_ms: now - 14 * hour + 3 * hour },
    { id: 'staging-r9-end', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'end_round', round: 9, secret: 67, winner: p3, winner_guess: 68, pot: 3, participants: 3 }), timestamp_ms: now - 8 * hour },

    // Round 10 — 6h — completed (started 8h ago, ended 2h ago) — secret=45 — alice_s wins
    { id: 'staging-r10-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: 10, seed_hash: seedHashes[8], active_duration_ms: 21600000, min_players: MIN_PLAYERS, max_guesses_per_player: 10, mode: 'normal', duration_track: '6h' }), timestamp_ms: now - 8 * hour },
    { id: 'staging-r10-g1', to: APP_PUBKEY, from_pubkey: p1, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 10, guess: 44 }), timestamp_ms: now - 8 * hour + hour },
    { id: 'staging-r10-g2', to: APP_PUBKEY, from_pubkey: p2, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 10, guess: 50 }), timestamp_ms: now - 8 * hour + 2 * hour },
    { id: 'staging-r10-g3', to: APP_PUBKEY, from_pubkey: p3, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 10, guess: 40 }), timestamp_ms: now - 8 * hour + 3 * hour },
    { id: 'staging-r10-end', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'end_round', round: 10, secret: 45, winner: p1, winner_guess: 44, pot: 3, participants: 3 }), timestamp_ms: now - 2 * hour },

    // Round 11 — 6h — active (started 1h ago, expires in ~5h)
    { id: 'staging-r11-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: 11, seed_hash: activeHashes.r11, active_duration_ms: 21600000, min_players: MIN_PLAYERS, max_guesses_per_player: 10, mode: 'normal', duration_track: '6h' }), timestamp_ms: now - hour },
    { id: 'staging-r11-g1', to: APP_PUBKEY, from_pubkey: p2, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 11, guess: 42 }), timestamp_ms: now - 45 * 60000 },
    { id: 'staging-r11-g2', to: APP_PUBKEY, from_pubkey: p3, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 11, guess: 60 }), timestamp_ms: now - 30 * 60000 },

    // Round 12 — 1d — active (started 2h ago, expires in ~22h)
    { id: 'staging-r12-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: 12, seed_hash: activeHashes.r12, active_duration_ms: 86400000, min_players: MIN_PLAYERS, max_guesses_per_player: 10, mode: 'normal', duration_track: '1d' }), timestamp_ms: now - 2 * hour },
    { id: 'staging-r12-g1', to: APP_PUBKEY, from_pubkey: p1, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 12, guess: 25 }), timestamp_ms: now - hour - 30 * 60000 },
    { id: 'staging-r12-g2', to: APP_PUBKEY, from_pubkey: p2, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 12, guess: 60 }), timestamp_ms: now - hour },
    // Round 12 ends (multi-guess 1d round → 1d history) so the 1d track has exactly
    // one live round on boot: the single-guess round 13 below. secret=20 (seed_hash
    // 0x00000077 % 100 + 1); p1's 25 is closest → p1 wins.
    { id: 'staging-r12-end', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'end_round', round: 12, secret: 20, winner: p1, winner_guess: 25, pot: 2, participants: 2 }), timestamp_ms: now - 30 * 60000 },

    // Round 13 — 1d — ACTIVE, SINGLE-GUESS, MEDIUM (range 1–100). Started 20 min ago,
    // so it is the current 1d round the player lands on. Only p2 has guessed, so the
    // signed-in staging wallet has ZERO guesses and the Place Guess button is live:
    // pressing it opens the bridge approval popup, and after approval the card flips
    // to the "locked in" state. The multi-guess flow is exercisable on the 6h (round
    // 11) and 1w (round 6) tracks, which keep their seeded active multi-guess rounds.
    { id: 'staging-r13-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: 13, seed_hash: '00000050' + 'a'.repeat(56), active_duration_ms: 86400000, min_players: MIN_PLAYERS, max_guesses_per_player: 1, mode: 'normal', duration_track: '1d', difficulty: 'medium' }), timestamp_ms: now - 20 * 60000 },
    { id: 'staging-r13-g1', to: APP_PUBKEY, from_pubkey: p2, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 13, guess: 60 }), timestamp_ms: now - 18 * 60000 },

    // ---- Extra 1D rounds for leaderboard demonstration (multi-guess, varied bestWinGuessCount) ----
    // Rounds 20–30: 11 completed 1d rounds, each ~1 day long, placed 20–30 days in the past.
    // p4: wins rounds 20 (1 guess) + 23 (3 guesses) + 27 (2 guesses) → bestWinGuessCount=1, 3 wins
    // p5: wins rounds 21 (1 guess) + 25 (4 guesses) → bestWinGuessCount=1, 2 wins
    // p6: wins round 22 with 3 guesses → bestWinGuessCount=3
    // p7: wins round 24 with 4 guesses → bestWinGuessCount=4
    // p8: wins round 26 with 4 guesses → bestWinGuessCount=4 (tied with p7)
    // p9: wins round 28 with 7 guesses → bestWinGuessCount=7
    // p10: wins round 29 with 8 guesses → bestWinGuessCount=8
    // p11: wins round 30 with 9 guesses → bestWinGuessCount=9 (11th, outside top-10)

    // Round 20 — p4 wins with 1 guess (bullseye on secret=50)
    { id: 'staging-r20-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: 20, seed_hash: seedHashes[9], active_duration_ms: TIMER_DURATION_MS, min_players: MIN_PLAYERS, max_guesses_per_player: 10, mode: 'normal', duration_track: '1d' }), timestamp_ms: now - 30 * day },
    { id: 'staging-r20-g1', to: APP_PUBKEY, from_pubkey: p4, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 20, guess: 50 }), timestamp_ms: now - 30 * day + hour },
    { id: 'staging-r20-g2', to: APP_PUBKEY, from_pubkey: p5, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 20, guess: 40 }), timestamp_ms: now - 30 * day + 2 * hour },
    { id: 'staging-r20-g3', to: APP_PUBKEY, from_pubkey: p6, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 20, guess: 60 }), timestamp_ms: now - 30 * day + 3 * hour },
    { id: 'staging-r20-end', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'end_round', round: 20, secret: 50, winner: p4, winner_guess: 50, pot: 3, participants: 3 }), timestamp_ms: now - 29 * day },

    // Round 21 — p5 wins with 1 guess (bullseye on secret=70)
    { id: 'staging-r21-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: 21, seed_hash: seedHashes[10], active_duration_ms: TIMER_DURATION_MS, min_players: MIN_PLAYERS, max_guesses_per_player: 10, mode: 'normal', duration_track: '1d' }), timestamp_ms: now - 29 * day },
    { id: 'staging-r21-g1', to: APP_PUBKEY, from_pubkey: p5, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 21, guess: 70 }), timestamp_ms: now - 29 * day + hour },
    { id: 'staging-r21-g2', to: APP_PUBKEY, from_pubkey: p4, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 21, guess: 65 }), timestamp_ms: now - 29 * day + 2 * hour },
    { id: 'staging-r21-g3', to: APP_PUBKEY, from_pubkey: p6, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 21, guess: 75 }), timestamp_ms: now - 29 * day + 3 * hour },
    { id: 'staging-r21-end', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'end_round', round: 21, secret: 70, winner: p5, winner_guess: 70, pot: 3, participants: 3 }), timestamp_ms: now - 28 * day },

    // Round 22 — p6 wins with 3 guesses (secret=30; guesses: 50→40→30)
    { id: 'staging-r22-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: 22, seed_hash: seedHashes[11], active_duration_ms: TIMER_DURATION_MS, min_players: MIN_PLAYERS, max_guesses_per_player: 10, mode: 'normal', duration_track: '1d' }), timestamp_ms: now - 28 * day },
    { id: 'staging-r22-g1', to: APP_PUBKEY, from_pubkey: p6, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 22, guess: 50 }), timestamp_ms: now - 28 * day + hour },
    { id: 'staging-r22-g2', to: APP_PUBKEY, from_pubkey: p6, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 22, guess: 40 }), timestamp_ms: now - 28 * day + 2 * hour },
    { id: 'staging-r22-g3', to: APP_PUBKEY, from_pubkey: p7, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 22, guess: 32 }), timestamp_ms: now - 28 * day + 3 * hour },
    { id: 'staging-r22-g4', to: APP_PUBKEY, from_pubkey: p6, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 22, guess: 30 }), timestamp_ms: now - 28 * day + 4 * hour },
    { id: 'staging-r22-g5', to: APP_PUBKEY, from_pubkey: p4, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 22, guess: 28 }), timestamp_ms: now - 28 * day + 5 * hour },
    { id: 'staging-r22-end', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'end_round', round: 22, secret: 30, winner: p6, winner_guess: 30, pot: 5, participants: 3 }), timestamp_ms: now - 27 * day },

    // Round 23 — p4 wins with 3 guesses (2nd win; bestWinGuessCount stays 1 from round 20; secret=45)
    { id: 'staging-r23-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: 23, seed_hash: seedHashes[12], active_duration_ms: TIMER_DURATION_MS, min_players: MIN_PLAYERS, max_guesses_per_player: 10, mode: 'normal', duration_track: '1d' }), timestamp_ms: now - 27 * day },
    { id: 'staging-r23-g1', to: APP_PUBKEY, from_pubkey: p4, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 23, guess: 60 }), timestamp_ms: now - 27 * day + hour },
    { id: 'staging-r23-g2', to: APP_PUBKEY, from_pubkey: p4, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 23, guess: 50 }), timestamp_ms: now - 27 * day + 2 * hour },
    { id: 'staging-r23-g3', to: APP_PUBKEY, from_pubkey: p5, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 23, guess: 43 }), timestamp_ms: now - 27 * day + 3 * hour },
    { id: 'staging-r23-g4', to: APP_PUBKEY, from_pubkey: p4, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 23, guess: 45 }), timestamp_ms: now - 27 * day + 4 * hour },
    { id: 'staging-r23-g5', to: APP_PUBKEY, from_pubkey: p7, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 23, guess: 47 }), timestamp_ms: now - 27 * day + 5 * hour },
    { id: 'staging-r23-end', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'end_round', round: 23, secret: 45, winner: p4, winner_guess: 45, pot: 5, participants: 3 }), timestamp_ms: now - 26 * day },

    // Round 24 — p7 wins with 4 guesses (secret=75; guesses: 50→60→70→75)
    { id: 'staging-r24-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: 24, seed_hash: seedHashes[13], active_duration_ms: TIMER_DURATION_MS, min_players: MIN_PLAYERS, max_guesses_per_player: 10, mode: 'normal', duration_track: '1d' }), timestamp_ms: now - 26 * day },
    { id: 'staging-r24-g1', to: APP_PUBKEY, from_pubkey: p7, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 24, guess: 50 }), timestamp_ms: now - 26 * day + hour },
    { id: 'staging-r24-g2', to: APP_PUBKEY, from_pubkey: p7, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 24, guess: 60 }), timestamp_ms: now - 26 * day + 2 * hour },
    { id: 'staging-r24-g3', to: APP_PUBKEY, from_pubkey: p8, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 24, guess: 73 }), timestamp_ms: now - 26 * day + 3 * hour },
    { id: 'staging-r24-g4', to: APP_PUBKEY, from_pubkey: p7, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 24, guess: 70 }), timestamp_ms: now - 26 * day + 4 * hour },
    { id: 'staging-r24-g5', to: APP_PUBKEY, from_pubkey: p5, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 24, guess: 77 }), timestamp_ms: now - 26 * day + 5 * hour },
    { id: 'staging-r24-g6', to: APP_PUBKEY, from_pubkey: p7, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 24, guess: 75 }), timestamp_ms: now - 26 * day + 6 * hour },
    { id: 'staging-r24-end', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'end_round', round: 24, secret: 75, winner: p7, winner_guess: 75, pot: 6, participants: 3 }), timestamp_ms: now - 25 * day },

    // Round 25 — p5 wins with 4 guesses (2nd win; bestWinGuessCount stays 1 from round 21; secret=60)
    { id: 'staging-r25-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: 25, seed_hash: seedHashes[14], active_duration_ms: TIMER_DURATION_MS, min_players: MIN_PLAYERS, max_guesses_per_player: 10, mode: 'normal', duration_track: '1d' }), timestamp_ms: now - 25 * day },
    { id: 'staging-r25-g1', to: APP_PUBKEY, from_pubkey: p5, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 25, guess: 50 }), timestamp_ms: now - 25 * day + hour },
    { id: 'staging-r25-g2', to: APP_PUBKEY, from_pubkey: p5, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 25, guess: 40 }), timestamp_ms: now - 25 * day + 2 * hour },
    { id: 'staging-r25-g3', to: APP_PUBKEY, from_pubkey: p6, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 25, guess: 58 }), timestamp_ms: now - 25 * day + 3 * hour },
    { id: 'staging-r25-g4', to: APP_PUBKEY, from_pubkey: p5, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 25, guess: 55 }), timestamp_ms: now - 25 * day + 4 * hour },
    { id: 'staging-r25-g5', to: APP_PUBKEY, from_pubkey: p8, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 25, guess: 62 }), timestamp_ms: now - 25 * day + 5 * hour },
    { id: 'staging-r25-g6', to: APP_PUBKEY, from_pubkey: p5, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 25, guess: 60 }), timestamp_ms: now - 25 * day + 6 * hour },
    { id: 'staging-r25-end', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'end_round', round: 25, secret: 60, winner: p5, winner_guess: 60, pot: 6, participants: 3 }), timestamp_ms: now - 24 * day },

    // Round 26 — p8 wins with 4 guesses (secret=35; guesses: 50→40→37→35)
    { id: 'staging-r26-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: 26, seed_hash: seedHashes[15], active_duration_ms: TIMER_DURATION_MS, min_players: MIN_PLAYERS, max_guesses_per_player: 10, mode: 'normal', duration_track: '1d' }), timestamp_ms: now - 24 * day },
    { id: 'staging-r26-g1', to: APP_PUBKEY, from_pubkey: p8, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 26, guess: 50 }), timestamp_ms: now - 24 * day + hour },
    { id: 'staging-r26-g2', to: APP_PUBKEY, from_pubkey: p8, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 26, guess: 40 }), timestamp_ms: now - 24 * day + 2 * hour },
    { id: 'staging-r26-g3', to: APP_PUBKEY, from_pubkey: p9, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 26, guess: 33 }), timestamp_ms: now - 24 * day + 3 * hour },
    { id: 'staging-r26-g4', to: APP_PUBKEY, from_pubkey: p8, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 26, guess: 37 }), timestamp_ms: now - 24 * day + 4 * hour },
    { id: 'staging-r26-g5', to: APP_PUBKEY, from_pubkey: p6, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 26, guess: 38 }), timestamp_ms: now - 24 * day + 5 * hour },
    { id: 'staging-r26-g6', to: APP_PUBKEY, from_pubkey: p8, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 26, guess: 35 }), timestamp_ms: now - 24 * day + 6 * hour },
    { id: 'staging-r26-end', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'end_round', round: 26, secret: 35, winner: p8, winner_guess: 35, pot: 6, participants: 3 }), timestamp_ms: now - 23 * day },

    // Round 27 — p4 wins with 2 guesses (3rd win; bestWinGuessCount stays 1; secret=80)
    { id: 'staging-r27-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: 27, seed_hash: seedHashes[16], active_duration_ms: TIMER_DURATION_MS, min_players: MIN_PLAYERS, max_guesses_per_player: 10, mode: 'normal', duration_track: '1d' }), timestamp_ms: now - 23 * day },
    { id: 'staging-r27-g1', to: APP_PUBKEY, from_pubkey: p4, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 27, guess: 60 }), timestamp_ms: now - 23 * day + hour },
    { id: 'staging-r27-g2', to: APP_PUBKEY, from_pubkey: p5, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 27, guess: 78 }), timestamp_ms: now - 23 * day + 2 * hour },
    { id: 'staging-r27-g3', to: APP_PUBKEY, from_pubkey: p4, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 27, guess: 80 }), timestamp_ms: now - 23 * day + 3 * hour },
    { id: 'staging-r27-g4', to: APP_PUBKEY, from_pubkey: p8, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 27, guess: 82 }), timestamp_ms: now - 23 * day + 4 * hour },
    { id: 'staging-r27-end', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'end_round', round: 27, secret: 80, winner: p4, winner_guess: 80, pot: 4, participants: 3 }), timestamp_ms: now - 22 * day },

    // Round 28 — p9 wins with 7 guesses (secret=55; binary-search style)
    { id: 'staging-r28-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: 28, seed_hash: seedHashes[17], active_duration_ms: TIMER_DURATION_MS, min_players: MIN_PLAYERS, max_guesses_per_player: 10, mode: 'normal', duration_track: '1d' }), timestamp_ms: now - 22 * day },
    { id: 'staging-r28-g1', to: APP_PUBKEY, from_pubkey: p9, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 28, guess: 30 }), timestamp_ms: now - 22 * day + hour },
    { id: 'staging-r28-g2', to: APP_PUBKEY, from_pubkey: p9, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 28, guess: 40 }), timestamp_ms: now - 22 * day + 2 * hour },
    { id: 'staging-r28-g3', to: APP_PUBKEY, from_pubkey: p10, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 28, guess: 53 }), timestamp_ms: now - 22 * day + 3 * hour },
    { id: 'staging-r28-g4', to: APP_PUBKEY, from_pubkey: p9, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 28, guess: 50 }), timestamp_ms: now - 22 * day + 4 * hour },
    { id: 'staging-r28-g5', to: APP_PUBKEY, from_pubkey: p9, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 28, guess: 60 }), timestamp_ms: now - 22 * day + 5 * hour },
    { id: 'staging-r28-g6', to: APP_PUBKEY, from_pubkey: p9, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 28, guess: 57 }), timestamp_ms: now - 22 * day + 6 * hour },
    { id: 'staging-r28-g7', to: APP_PUBKEY, from_pubkey: p9, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 28, guess: 56 }), timestamp_ms: now - 22 * day + 7 * hour },
    { id: 'staging-r28-g8', to: APP_PUBKEY, from_pubkey: p11, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 28, guess: 57 }), timestamp_ms: now - 22 * day + 8 * hour },
    { id: 'staging-r28-g9', to: APP_PUBKEY, from_pubkey: p9, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 28, guess: 55 }), timestamp_ms: now - 22 * day + 9 * hour },
    { id: 'staging-r28-end', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'end_round', round: 28, secret: 55, winner: p9, winner_guess: 55, pot: 9, participants: 3 }), timestamp_ms: now - 21 * day },

    // Round 29 — p10 wins with 8 guesses (secret=40)
    { id: 'staging-r29-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: 29, seed_hash: seedHashes[18], active_duration_ms: TIMER_DURATION_MS, min_players: MIN_PLAYERS, max_guesses_per_player: 10, mode: 'normal', duration_track: '1d' }), timestamp_ms: now - 21 * day },
    { id: 'staging-r29-g1', to: APP_PUBKEY, from_pubkey: p10, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 29, guess: 50 }), timestamp_ms: now - 21 * day + hour },
    { id: 'staging-r29-g2', to: APP_PUBKEY, from_pubkey: p10, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 29, guess: 60 }), timestamp_ms: now - 21 * day + 2 * hour },
    { id: 'staging-r29-g3', to: APP_PUBKEY, from_pubkey: p11, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 29, guess: 38 }), timestamp_ms: now - 21 * day + 3 * hour },
    { id: 'staging-r29-g4', to: APP_PUBKEY, from_pubkey: p10, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 29, guess: 45 }), timestamp_ms: now - 21 * day + 4 * hour },
    { id: 'staging-r29-g5', to: APP_PUBKEY, from_pubkey: p10, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 29, guess: 42 }), timestamp_ms: now - 21 * day + 5 * hour },
    { id: 'staging-r29-g6', to: APP_PUBKEY, from_pubkey: p9, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 29, guess: 42 }), timestamp_ms: now - 21 * day + 6 * hour },
    { id: 'staging-r29-g7', to: APP_PUBKEY, from_pubkey: p10, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 29, guess: 41 }), timestamp_ms: now - 21 * day + 7 * hour },
    { id: 'staging-r29-g8', to: APP_PUBKEY, from_pubkey: p10, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 29, guess: 43 }), timestamp_ms: now - 21 * day + 8 * hour },
    { id: 'staging-r29-g9', to: APP_PUBKEY, from_pubkey: p10, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 29, guess: 44 }), timestamp_ms: now - 21 * day + 9 * hour },
    { id: 'staging-r29-g10', to: APP_PUBKEY, from_pubkey: p10, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 29, guess: 40 }), timestamp_ms: now - 21 * day + 10 * hour },
    { id: 'staging-r29-end', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'end_round', round: 29, secret: 40, winner: p10, winner_guess: 40, pot: 10, participants: 3 }), timestamp_ms: now - 20 * day },

    // Round 30 — p11 wins with 9 guesses (secret=65; 11th place — outside top-10 cap)
    { id: 'staging-r30-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: 30, seed_hash: seedHashes[19], active_duration_ms: TIMER_DURATION_MS, min_players: MIN_PLAYERS, max_guesses_per_player: 10, mode: 'normal', duration_track: '1d' }), timestamp_ms: now - 20 * day },
    { id: 'staging-r30-g1', to: APP_PUBKEY, from_pubkey: p11, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 30, guess: 50 }), timestamp_ms: now - 20 * day + hour },
    { id: 'staging-r30-g2', to: APP_PUBKEY, from_pubkey: p11, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 30, guess: 60 }), timestamp_ms: now - 20 * day + 2 * hour },
    { id: 'staging-r30-g3', to: APP_PUBKEY, from_pubkey: p11, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 30, guess: 55 }), timestamp_ms: now - 20 * day + 3 * hour },
    { id: 'staging-r30-g4', to: APP_PUBKEY, from_pubkey: p11, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 30, guess: 58 }), timestamp_ms: now - 20 * day + 4 * hour },
    { id: 'staging-r30-g5', to: APP_PUBKEY, from_pubkey: p11, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 30, guess: 62 }), timestamp_ms: now - 20 * day + 5 * hour },
    { id: 'staging-r30-g6', to: APP_PUBKEY, from_pubkey: p11, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 30, guess: 63 }), timestamp_ms: now - 20 * day + 6 * hour },
    { id: 'staging-r30-g7', to: APP_PUBKEY, from_pubkey: p11, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 30, guess: 64 }), timestamp_ms: now - 20 * day + 7 * hour },
    { id: 'staging-r30-g8', to: APP_PUBKEY, from_pubkey: p8, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 30, guess: 63 }), timestamp_ms: now - 20 * day + 8 * hour },
    { id: 'staging-r30-g9', to: APP_PUBKEY, from_pubkey: p11, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 30, guess: 66 }), timestamp_ms: now - 20 * day + 9 * hour },
    { id: 'staging-r30-g10', to: APP_PUBKEY, from_pubkey: p11, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 30, guess: 65 }), timestamp_ms: now - 20 * day + 10 * hour },
    { id: 'staging-r30-end', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'end_round', round: 30, secret: 65, winner: p11, winner_guess: 65, pot: 10, participants: 2 }), timestamp_ms: now - 19 * day },

    // ---- EASY DIFFICULTY ROUNDS (range 1–10) ----
    // Seed hashes: parseInt(hash.slice(0,8),16) % 10 == secret-1
    // secret=5: "00000004"=4, 4%10=4, +1=5. secret=3: "00000002"=2, 2%10=2, +1=3. secret=7: "00000006"=6, 6%10=6, +1=7.

    // Round 50 — Easy, 1d, secret=5 — alice_s wins with 1 guess (bullseye)
    { id: 'staging-r50-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: 50, seed_hash: '00000004' + 'a'.repeat(56), active_duration_ms: TIMER_DURATION_MS, min_players: MIN_PLAYERS, max_guesses_per_player: 5, mode: 'normal', duration_track: '1d', difficulty: 'easy' }), timestamp_ms: now - 50 * day },
    { id: 'staging-r50-g1', to: APP_PUBKEY, from_pubkey: p1, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 50, guess: 5 }), timestamp_ms: now - 50 * day + hour },
    { id: 'staging-r50-g2', to: APP_PUBKEY, from_pubkey: p2, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 50, guess: 3 }), timestamp_ms: now - 50 * day + 2 * hour },
    { id: 'staging-r50-g3', to: APP_PUBKEY, from_pubkey: p3, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 50, guess: 8 }), timestamp_ms: now - 50 * day + 3 * hour },
    { id: 'staging-r50-end', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'end_round', round: 50, secret: 5, winner: p1, winner_guess: 5, pot: 3, participants: 3 }), timestamp_ms: now - 49 * day },

    // Round 51 — Easy, 1d, secret=3 — bob_s wins with 2 guesses
    { id: 'staging-r51-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: 51, seed_hash: '00000002' + 'b'.repeat(56), active_duration_ms: TIMER_DURATION_MS, min_players: MIN_PLAYERS, max_guesses_per_player: 5, mode: 'normal', duration_track: '1d', difficulty: 'easy' }), timestamp_ms: now - 49 * day },
    { id: 'staging-r51-g1', to: APP_PUBKEY, from_pubkey: p2, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 51, guess: 7 }), timestamp_ms: now - 49 * day + hour },
    { id: 'staging-r51-g2', to: APP_PUBKEY, from_pubkey: p1, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 51, guess: 6 }), timestamp_ms: now - 49 * day + 2 * hour },
    { id: 'staging-r51-g3', to: APP_PUBKEY, from_pubkey: p3, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 51, guess: 1 }), timestamp_ms: now - 49 * day + 3 * hour },
    { id: 'staging-r51-g4', to: APP_PUBKEY, from_pubkey: p2, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 51, guess: 3 }), timestamp_ms: now - 49 * day + 4 * hour },
    { id: 'staging-r51-end', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'end_round', round: 51, secret: 3, winner: p2, winner_guess: 3, pot: 4, participants: 3 }), timestamp_ms: now - 48 * day },

    // Round 52 — Easy, 1d, secret=7 — carol_s wins with 4 guesses
    { id: 'staging-r52-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: 52, seed_hash: '00000006' + 'c'.repeat(56), active_duration_ms: TIMER_DURATION_MS, min_players: MIN_PLAYERS, max_guesses_per_player: 5, mode: 'normal', duration_track: '1d', difficulty: 'easy' }), timestamp_ms: now - 48 * day },
    { id: 'staging-r52-g1', to: APP_PUBKEY, from_pubkey: p3, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 52, guess: 2 }), timestamp_ms: now - 48 * day + hour },
    { id: 'staging-r52-g2', to: APP_PUBKEY, from_pubkey: p1, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 52, guess: 4 }), timestamp_ms: now - 48 * day + 2 * hour },
    { id: 'staging-r52-g3', to: APP_PUBKEY, from_pubkey: p3, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 52, guess: 9 }), timestamp_ms: now - 48 * day + 3 * hour },
    { id: 'staging-r52-g4', to: APP_PUBKEY, from_pubkey: p2, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 52, guess: 8 }), timestamp_ms: now - 48 * day + 4 * hour },
    { id: 'staging-r52-g5', to: APP_PUBKEY, from_pubkey: p3, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 52, guess: 5 }), timestamp_ms: now - 48 * day + 5 * hour },
    { id: 'staging-r52-g6', to: APP_PUBKEY, from_pubkey: p3, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 52, guess: 7 }), timestamp_ms: now - 48 * day + 6 * hour },
    { id: 'staging-r52-end', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'end_round', round: 52, secret: 7, winner: p3, winner_guess: 7, pot: 6, participants: 3 }), timestamp_ms: now - 47 * day },

    // ---- HARD DIFFICULTY ROUNDS (range 1–1000) ----
    // Seed hashes: parseInt(hash.slice(0,8),16) % 1000 == secret-1
    // secret=500: "000001f3"=499, 499%1000=499, +1=500. secret=750: "000002ed"=749, 749%1000=749, +1=750. secret=250: "000000f9"=249, 249%1000=249, +1=250.

    // Round 60 — Hard, 1d, secret=500 — dave_s wins with 4 guesses
    { id: 'staging-r60-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: 60, seed_hash: '000001f3' + 'd'.repeat(56), active_duration_ms: TIMER_DURATION_MS, min_players: MIN_PLAYERS, max_guesses_per_player: 15, mode: 'normal', duration_track: '1d', difficulty: 'hard' }), timestamp_ms: now - 45 * day },
    { id: 'staging-r60-g1', to: APP_PUBKEY, from_pubkey: p4, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 60, guess: 250 }), timestamp_ms: now - 45 * day + hour },
    { id: 'staging-r60-g2', to: APP_PUBKEY, from_pubkey: p5, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 60, guess: 600 }), timestamp_ms: now - 45 * day + 2 * hour },
    { id: 'staging-r60-g3', to: APP_PUBKEY, from_pubkey: p4, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 60, guess: 750 }), timestamp_ms: now - 45 * day + 3 * hour },
    { id: 'staging-r60-g4', to: APP_PUBKEY, from_pubkey: p6, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 60, guess: 300 }), timestamp_ms: now - 45 * day + 4 * hour },
    { id: 'staging-r60-g5', to: APP_PUBKEY, from_pubkey: p4, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 60, guess: 400 }), timestamp_ms: now - 45 * day + 5 * hour },
    { id: 'staging-r60-g6', to: APP_PUBKEY, from_pubkey: p4, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 60, guess: 500 }), timestamp_ms: now - 45 * day + 6 * hour },
    { id: 'staging-r60-end', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'end_round', round: 60, secret: 500, winner: p4, winner_guess: 500, pot: 6, participants: 3 }), timestamp_ms: now - 44 * day },

    // Round 61 — Hard, 1d, secret=750 — eve_s wins with 7 guesses
    { id: 'staging-r61-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: 61, seed_hash: '000002ed' + 'e'.repeat(56), active_duration_ms: TIMER_DURATION_MS, min_players: MIN_PLAYERS, max_guesses_per_player: 15, mode: 'normal', duration_track: '1d', difficulty: 'hard' }), timestamp_ms: now - 44 * day },
    { id: 'staging-r61-g1', to: APP_PUBKEY, from_pubkey: p5, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 61, guess: 500 }), timestamp_ms: now - 44 * day + hour },
    { id: 'staging-r61-g2', to: APP_PUBKEY, from_pubkey: p4, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 61, guess: 700 }), timestamp_ms: now - 44 * day + 2 * hour },
    { id: 'staging-r61-g3', to: APP_PUBKEY, from_pubkey: p5, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 61, guess: 900 }), timestamp_ms: now - 44 * day + 3 * hour },
    { id: 'staging-r61-g4', to: APP_PUBKEY, from_pubkey: p6, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 61, guess: 800 }), timestamp_ms: now - 44 * day + 4 * hour },
    { id: 'staging-r61-g5', to: APP_PUBKEY, from_pubkey: p5, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 61, guess: 800 }), timestamp_ms: now - 44 * day + 5 * hour },
    { id: 'staging-r61-g6', to: APP_PUBKEY, from_pubkey: p5, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 61, guess: 780 }), timestamp_ms: now - 44 * day + 6 * hour },
    { id: 'staging-r61-g7', to: APP_PUBKEY, from_pubkey: p5, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 61, guess: 760 }), timestamp_ms: now - 44 * day + 7 * hour },
    { id: 'staging-r61-g8', to: APP_PUBKEY, from_pubkey: p5, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 61, guess: 750 }), timestamp_ms: now - 44 * day + 8 * hour },
    { id: 'staging-r61-end', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'end_round', round: 61, secret: 750, winner: p5, winner_guess: 750, pot: 8, participants: 3 }), timestamp_ms: now - 43 * day },

    // Round 62 — Hard, 1d, secret=250 — alice_s wins with 10 guesses
    { id: 'staging-r62-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: 62, seed_hash: '000000f9' + 'f'.repeat(56), active_duration_ms: TIMER_DURATION_MS, min_players: MIN_PLAYERS, max_guesses_per_player: 15, mode: 'normal', duration_track: '1d', difficulty: 'hard' }), timestamp_ms: now - 43 * day },
    { id: 'staging-r62-g1', to: APP_PUBKEY, from_pubkey: p1, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 62, guess: 500 }), timestamp_ms: now - 43 * day + hour },
    { id: 'staging-r62-g2', to: APP_PUBKEY, from_pubkey: p4, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 62, guess: 400 }), timestamp_ms: now - 43 * day + 2 * hour },
    { id: 'staging-r62-g3', to: APP_PUBKEY, from_pubkey: p1, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 62, guess: 200 }), timestamp_ms: now - 43 * day + 3 * hour },
    { id: 'staging-r62-g4', to: APP_PUBKEY, from_pubkey: p5, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 62, guess: 600 }), timestamp_ms: now - 43 * day + 4 * hour },
    { id: 'staging-r62-g5', to: APP_PUBKEY, from_pubkey: p1, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 62, guess: 100 }), timestamp_ms: now - 43 * day + 5 * hour },
    { id: 'staging-r62-g6', to: APP_PUBKEY, from_pubkey: p1, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 62, guess: 700 }), timestamp_ms: now - 43 * day + 6 * hour },
    { id: 'staging-r62-g7', to: APP_PUBKEY, from_pubkey: p1, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 62, guess: 300 }), timestamp_ms: now - 43 * day + 7 * hour },
    { id: 'staging-r62-g8', to: APP_PUBKEY, from_pubkey: p1, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 62, guess: 800 }), timestamp_ms: now - 43 * day + 8 * hour },
    { id: 'staging-r62-g9', to: APP_PUBKEY, from_pubkey: p1, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 62, guess: 230 }), timestamp_ms: now - 43 * day + 9 * hour },
    { id: 'staging-r62-g10', to: APP_PUBKEY, from_pubkey: p1, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 62, guess: 250 }), timestamp_ms: now - 43 * day + 10 * hour },
    { id: 'staging-r62-end', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'end_round', round: 62, secret: 250, winner: p1, winner_guess: 250, pot: 10, participants: 3 }), timestamp_ms: now - 42 * day },

    // ---- BLOCKED PLAYER FIXTURE (user_vedge = p12) ----
    // Two 1d medium rounds won outright with a single bullseye guess. With
    // bestWinGuessCount=1 and the most wins, p12 would top the medium leaderboard
    // and be credited as the winner in history — UNLESS the hidden-users filter
    // removes them. After the change they must be absent from both surfaces.
    // Round 40 — 1d — medium — secret=50 — p12 wins with 1 guess (bullseye)
    { id: 'staging-r40-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: 40, seed_hash: '00000031' + '4'.repeat(56), active_duration_ms: TIMER_DURATION_MS, min_players: MIN_PLAYERS, max_guesses_per_player: 10, mode: 'normal', duration_track: '1d', difficulty: 'medium' }), timestamp_ms: now - 18 * day },
    { id: 'staging-r40-g1', to: APP_PUBKEY, from_pubkey: p12, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 40, guess: 50 }), timestamp_ms: now - 18 * day + hour },
    { id: 'staging-r40-g2', to: APP_PUBKEY, from_pubkey: p1, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 40, guess: 45 }), timestamp_ms: now - 18 * day + 2 * hour },
    { id: 'staging-r40-g3', to: APP_PUBKEY, from_pubkey: p2, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 40, guess: 60 }), timestamp_ms: now - 18 * day + 3 * hour },
    { id: 'staging-r40-end', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'end_round', round: 40, secret: 50, winner: p12, winner_guess: 50, pot: 3, participants: 3 }), timestamp_ms: now - 17 * day },

    // Round 41 — 1d — medium — secret=42 — p12 wins again with 1 guess (bullseye)
    { id: 'staging-r41-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: 41, seed_hash: '00000029' + '5'.repeat(56), active_duration_ms: TIMER_DURATION_MS, min_players: MIN_PLAYERS, max_guesses_per_player: 10, mode: 'normal', duration_track: '1d', difficulty: 'medium' }), timestamp_ms: now - 17 * day },
    { id: 'staging-r41-g1', to: APP_PUBKEY, from_pubkey: p12, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 41, guess: 42 }), timestamp_ms: now - 17 * day + hour },
    { id: 'staging-r41-g2', to: APP_PUBKEY, from_pubkey: p1, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 41, guess: 38 }), timestamp_ms: now - 17 * day + 2 * hour },
    { id: 'staging-r41-g3', to: APP_PUBKEY, from_pubkey: p3, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 41, guess: 50 }), timestamp_ms: now - 17 * day + 3 * hour },
    { id: 'staging-r41-end', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'end_round', round: 41, secret: 42, winner: p12, winner_guess: 42, pot: 3, participants: 3 }), timestamp_ms: now - 16 * day },

    // ---- UNNAMED PLAYER FIXTURE (p13 — no Usernode username) ----
    // A bullseye 1-guess win that WOULD make p13 the top medium-difficulty entry.
    // Because p13 never set a username (no u13 below), the "named players only"
    // filter must keep them off the leaderboard and out of history winner credit,
    // while named players (dave_s, eve_s, …) remain.
    // Round 42 — 1d — medium — secret=50 — p13 wins with 1 guess (bullseye)
    { id: 'staging-r42-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: 42, seed_hash: '00000031' + '6'.repeat(56), active_duration_ms: TIMER_DURATION_MS, min_players: MIN_PLAYERS, max_guesses_per_player: 10, mode: 'normal', duration_track: '1d', difficulty: 'medium' }), timestamp_ms: now - 16 * day },
    { id: 'staging-r42-g1', to: APP_PUBKEY, from_pubkey: p13, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 42, guess: 50 }), timestamp_ms: now - 16 * day + hour },
    { id: 'staging-r42-g2', to: APP_PUBKEY, from_pubkey: p4, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 42, guess: 44 }), timestamp_ms: now - 16 * day + 2 * hour },
    { id: 'staging-r42-g3', to: APP_PUBKEY, from_pubkey: p5, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 42, guess: 58 }), timestamp_ms: now - 16 * day + 3 * hour },
    { id: 'staging-r42-end', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'end_round', round: 42, secret: 50, winner: p13, winner_guess: 50, pot: 3, participants: 3 }), timestamp_ms: now - 15 * day },

    // Staging usernames
    { id: 'staging-u1', to: 'ut1p0p7y8ujacndc60r4a7pzk45dufdtarp6satvc0md7866633u8sqagm3az', from_pubkey: p1, amount: 1, memo: JSON.stringify({ app: 'usernames', type: 'set_username', username: 'alice_s' }), timestamp_ms: now - 3 * day },
    { id: 'staging-u2', to: 'ut1p0p7y8ujacndc60r4a7pzk45dufdtarp6satvc0md7866633u8sqagm3az', from_pubkey: p2, amount: 1, memo: JSON.stringify({ app: 'usernames', type: 'set_username', username: 'bob_s' }), timestamp_ms: now - 3 * day },
    { id: 'staging-u3', to: 'ut1p0p7y8ujacndc60r4a7pzk45dufdtarp6satvc0md7866633u8sqagm3az', from_pubkey: p3, amount: 1, memo: JSON.stringify({ app: 'usernames', type: 'set_username', username: 'carol_s' }), timestamp_ms: now - 3 * day },
    { id: 'staging-u4', to: 'ut1p0p7y8ujacndc60r4a7pzk45dufdtarp6satvc0md7866633u8sqagm3az', from_pubkey: p4, amount: 1, memo: JSON.stringify({ app: 'usernames', type: 'set_username', username: 'dave_s' }), timestamp_ms: now - 31 * day },
    { id: 'staging-u5', to: 'ut1p0p7y8ujacndc60r4a7pzk45dufdtarp6satvc0md7866633u8sqagm3az', from_pubkey: p5, amount: 1, memo: JSON.stringify({ app: 'usernames', type: 'set_username', username: 'eve_s' }), timestamp_ms: now - 31 * day },
    { id: 'staging-u6', to: 'ut1p0p7y8ujacndc60r4a7pzk45dufdtarp6satvc0md7866633u8sqagm3az', from_pubkey: p6, amount: 1, memo: JSON.stringify({ app: 'usernames', type: 'set_username', username: 'frank_s' }), timestamp_ms: now - 31 * day },
    { id: 'staging-u7', to: 'ut1p0p7y8ujacndc60r4a7pzk45dufdtarp6satvc0md7866633u8sqagm3az', from_pubkey: p7, amount: 1, memo: JSON.stringify({ app: 'usernames', type: 'set_username', username: 'grace_s' }), timestamp_ms: now - 31 * day },
    { id: 'staging-u8', to: 'ut1p0p7y8ujacndc60r4a7pzk45dufdtarp6satvc0md7866633u8sqagm3az', from_pubkey: p8, amount: 1, memo: JSON.stringify({ app: 'usernames', type: 'set_username', username: 'henry_s' }), timestamp_ms: now - 31 * day },
    { id: 'staging-u9', to: 'ut1p0p7y8ujacndc60r4a7pzk45dufdtarp6satvc0md7866633u8sqagm3az', from_pubkey: p9, amount: 1, memo: JSON.stringify({ app: 'usernames', type: 'set_username', username: 'iris_s' }), timestamp_ms: now - 31 * day },
    { id: 'staging-u10', to: 'ut1p0p7y8ujacndc60r4a7pzk45dufdtarp6satvc0md7866633u8sqagm3az', from_pubkey: p10, amount: 1, memo: JSON.stringify({ app: 'usernames', type: 'set_username', username: 'jake_s' }), timestamp_ms: now - 31 * day },
    { id: 'staging-u11', to: 'ut1p0p7y8ujacndc60r4a7pzk45dufdtarp6satvc0md7866633u8sqagm3az', from_pubkey: p11, amount: 1, memo: JSON.stringify({ app: 'usernames', type: 'set_username', username: 'kate_s' }), timestamp_ms: now - 31 * day },
    // The blocked player's chosen name. Resolved to p12 by syncHiddenFromUsernames
    // at request time, which drives the hide for the chain-derived leaderboard.
    { id: 'staging-u12', to: 'ut1p0p7y8ujacndc60r4a7pzk45dufdtarp6satvc0md7866633u8sqagm3az', from_pubkey: p12, amount: 1, memo: JSON.stringify({ app: 'usernames', type: 'set_username', username: 'user_vedge' }), timestamp_ms: now - 16 * day },
  ];

  // Route each seed tx to the right cache: numguess txs drive the game state,
  // while `set_username` txs must populate the usernames cache (the real, and
  // now only, source of names) so seeded players render their friendly names.
  const usernameSeedTxs = [];
  for (const tx of fakeTxs) {
    let memo = tx.memo;
    if (typeof memo === 'string') {
      try { memo = JSON.parse(memo); } catch { memo = null; }
    }
    if (memo && memo.app === 'usernames') {
      usernameSeedTxs.push(tx);
    } else {
      game.processTransaction(tx);
    }
  }
  usernamesCache.injectSeedTransactions(usernameSeedTxs);
  console.log('[staging] Injected', fakeTxs.length, 'seed transactions (', usernameSeedTxs.length, 'usernames )');
}

// ---------------------------------------------------------------------------
// Payout logic
// ---------------------------------------------------------------------------

async function walletSend(to, amount, memo) {
  const memoStr = typeof memo === 'string' ? memo : JSON.stringify(memo);
  const resp = await fetch(`${NODE_RPC_URL}/wallet/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to, amount, memo: memoStr }),
    signal: AbortSignal.timeout(60000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`wallet/send ${resp.status}: ${text}`);
  }
  return resp.json();
}

async function configureSigner() {
  if (!APP_SECRET_KEY) return;
  const resp = await fetch(`${NODE_RPC_URL}/wallet/signer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secretKey: APP_SECRET_KEY }),
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`wallet/signer ${resp.status}: ${text}`);
  }
}

// Configure the wallet signer at most once per successful call. The wallet
// process keeps the signer in memory, so a single successful configure covers
// every later send — but if the call fails we leave the flag false so the next
// send retries it (this also self-heals after a node restart clears the signer).
// Without this, the very first on-chain start_round send ran with no signer and
// failed, and because that send preceded the local state injection it stopped
// rounds from ever auto-starting in production.
let signerConfigured = false;
async function ensureSignerConfigured() {
  if (!APP_SECRET_KEY) return; // staging/dev: no on-chain sends, nothing to configure
  if (signerConfigured) return;
  await configureSigner();
  signerConfigured = true;
}

async function sendWithRetry(to, amount, memo, retries) {
  retries = retries != null ? retries : 3;
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await walletSend(to, amount, memo);
    } catch (e) {
      lastErr = e;
      console.error(`[payout] attempt ${i + 1}/${retries} failed:`, e.message);
      if (i < retries - 1) await new Promise((r) => setTimeout(r, 10000));
    }
  }
  throw lastErr;
}

async function concludeRound(round, track) {
  if (inFlightPayout[track]) return;
  inFlightPayout[track] = true;

  try {
    const secret = game.computeSecret(round.seedHash, round.range);
    const result = game.findWinner(round);
    if (!result || !result.winner) {
      console.log(`[payout:${track}] No valid guesses, skipping payout, starting next round`);
      await postEndRound(round, secret, null, null, 0, round.guesses.length);
      await postStartRound(track);
      inFlightPayout[track] = false;
      return;
    }

    const winner = result.winner.from;
    const pot = round.guesses.reduce((s, g) => s + g.amount, 0);

    console.log(`[payout:${track}] Round ${round.id}: secret=${secret}, winner=${winner}, pot=${pot}`);

    if (APP_SECRET_KEY) {
      await ensureSignerConfigured();

      // 1. Send payout to winner
      const payoutMemo = { app: 'numguess', type: 'payout', round: round.id, winner };
      await sendWithRetry(winner, pot, payoutMemo, 3);
      console.log(`[payout:${track}] Payout sent to`, winner);
    } else {
      console.log(`[payout:${track}] No APP_SECRET_KEY — skipping token payout (staging/dev mode)`);
    }

    // 2. Post end_round self-transfer (or inject locally in staging)
    // Win streaks are derived from completed rounds on read (game.getMyStreaks),
    // so there is no separate streak store to update here.
    await postEndRound(round, secret, winner, result.winner.guess, pot, round.guesses.length);

    // 3. Start next round for same track
    await postStartRound(track);
    inFlightPayout[track] = false;
  } catch (e) {
    console.error(`[payout:${track}] All retries failed:`, e.message);
    inFlightPayout[track] = false;
    setTimeout(() => checkTrack(track).catch((err) => console.error(`[checkTrack:${track}]`, err.message)), 60000);
  }
}

async function postEndRound(round, secret, winner, winnerGuess, pot, participants) {
  const memo = {
    app: 'numguess',
    type: 'end_round',
    round: round.id,
    secret,
    winner: winner || null,
    winner_guess: winnerGuess || null,
    pot,
    participants,
  };
  if (APP_SECRET_KEY) {
    try {
      await ensureSignerConfigured();
      await sendWithRetry(APP_PUBKEY, 0, memo, 3);
    } catch (e) {
      console.error('[payout] on-chain end_round post failed (continuing with local state):', e.message);
    }
  }
  // Always inject locally so state advances even if the on-chain post failed;
  // the real tx dedups by round id when it later backfills. (Only real path in staging.)
  game.processTransaction({
    id: `local-end-${round.id}-${Date.now()}`,
    to: APP_PUBKEY,
    from_pubkey: APP_PUBKEY,
    amount: 0,
    memo: JSON.stringify(memo),
    timestamp_ms: Date.now(),
  });
  console.log(`[payout] end_round posted for round ${round.id}`);
}

async function postStartRound(track) {
  // Determine next round ID (global sequential)
  let maxId = 0;
  for (const [id] of game.rounds) {
    if (id > maxId) maxId = id;
  }
  const roundId = maxId + 1;

  const activeDurationMs = TRACK_DURATIONS[track] || TIMER_DURATION_MS;
  const difficulty = pendingDifficulty[track] || 'medium';
  pendingDifficulty[track] = 'medium'; // consume config, reset to default
  const diffConfig = DIFFICULTIES[difficulty] || DIFFICULTIES.medium;
  const maxGuessesPerPlayer = diffConfig.maxGuesses;
  const roundMinPlayers = track === '1w' ? 1 : MIN_PLAYERS;

  const seedHash = crypto.randomBytes(32).toString('hex');
  const memo = {
    app: 'numguess',
    type: 'start_round',
    round: roundId,
    seed_hash: seedHash,
    active_duration_ms: activeDurationMs,
    min_players: roundMinPlayers,
    max_guesses_per_player: maxGuessesPerPlayer,
    mode: 'normal',
    duration_track: track,
    difficulty,
  };

  if (APP_SECRET_KEY) {
    try {
      await ensureSignerConfigured();
      await sendWithRetry(APP_PUBKEY, 0, memo, 3);
    } catch (e) {
      console.error('[round] on-chain start_round post failed (continuing with local state):', e.message);
    }
  }
  // Always inject locally so state advances even if the on-chain post failed;
  // the real tx dedups by round id when it later backfills. (Only real path in staging.)
  game.processTransaction({
    id: `local-start-${roundId}-${Date.now()}`,
    to: APP_PUBKEY,
    from_pubkey: APP_PUBKEY,
    amount: 0,
    memo: JSON.stringify(memo),
    timestamp_ms: Date.now(),
  });
  console.log(`[round] Started round ${roundId} (track=${track}, maxGuesses=${maxGuessesPerPlayer})`);
}

async function extendRound(round) {
  const newEndsAt = Date.now() + round.activeDurationMs;
  const memo = {
    app: 'numguess',
    type: 'start_round',
    round: round.id,
    seed_hash: round.seedHash,
    active_duration_ms: round.activeDurationMs,
    min_players: round.minPlayers,
  };
  // Update in memory immediately regardless of whether on-chain post succeeds
  round.endsAt = newEndsAt;
  if (APP_SECRET_KEY) {
    try {
      await sendWithRetry(APP_PUBKEY, 0, memo, 1);
    } catch (e) {
      console.warn('[round] extension memo post failed (continuing):', e.message);
    }
  }
  console.log(`[round] Extended round ${round.id}, new endsAt=${new Date(newEndsAt).toISOString()}`);
}

async function checkTrack(track) {
  if (inFlightPayout[track]) return;
  const currentRound = game.getCurrentRoundForTrack(track);
  if (!currentRound) {
    // No round for this track — create one
    try { await postStartRound(track); } catch (e) { console.error(`[round:${track}] Failed to create initial round:`, e.message); }
    return;
  }
  if (currentRound.endsAt > Date.now()) return; // not expired yet

  const participants = currentRound.guesses.length;
  if (participants >= currentRound.minPlayers) {
    await concludeRound(currentRound, track);
  } else {
    await extendRound(currentRound);
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// The bridge is loaded cross-origin directly from the canonical hosted copy
// (see public/index.html). Per platform convention it is never proxied or
// vendored per-app — fixes propagate fleet-wide on the next page load.

// Serve static scripts
app.get('/usernode-loading.js', (_req, res) => {
  res.set('content-type', 'application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'usernode-loading.js'));
});
app.get('/usernode-usernames.js', (_req, res) => {
  res.set('content-type', 'application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'usernode-usernames.js'));
});

// Explorer proxy
app.use((req, res, next) => {
  if (!req.path.startsWith(EXPLORER_PROXY_PREFIX)) return next();
  handleExplorerProxy(req, res, req.path);
});

// Hidden-player-aware usernames state. Registered BEFORE the generic cache
// handler below so it wins for this exact path: it omits any hidden pubkey from
// the directory the frontend consumes, so a blocked player's chosen name never
// reaches a client (residual references fall back to the neutral user_<last6>
// placeholder). The vendored usernames cache is left untouched.
app.get('/__usernames/state', (_req, res) => {
  const map = syncHiddenFromUsernames();
  const usernames = {};
  for (const pubkey of Object.keys(map)) {
    if (hidden.isHiddenPubkey(pubkey)) continue;
    usernames[pubkey] = map[pubkey];
  }
  res.set('cache-control', 'no-store');
  res.json({ usernames });
});

// Cache / status handlers
app.use((req, res, next) => {
  if (numguessCache.handleRequest(req, res, req.path)) return;
  if (usernamesCache.handleRequest(req, res, req.path)) return;
  if (nodeStatusProbe.handleRequest(req, res, req.path)) return;
  next();
});

// Game state endpoint — returns per-track data with per-track streaks
app.get('/__numguess/state', async (req, res) => {
  if (!numguessCache.isStreamReady()) {
    res.json({ loading: true, appPubkey: APP_PUBKEY, staging: IS_STAGING });
    return;
  }
  res.set('cache-control', 'no-store');
  // Resolve hide-by-username -> pubkey before deriving state so blocked players
  // are filtered everywhere this response touches (leaderboard, history, cards).
  syncHiddenFromUsernames();
  const state = game.getStateResponse();
  state.staging = IS_STAGING;
  state.pendingDifficulty = { ...pendingDifficulty };

  // Per-track win streaks for the signed-in player, derived purely from the
  // on-chain round history (no database). Same shape the frontend expects.
  if (req.user && req.user.usernode_pubkey) {
    state.myStreaks = game.getMyStreaks(req.user.usernode_pubkey);
  }

  res.json(state);
});

// Personal game history — the signed-in player's finished rounds. Under /api/
// so the deny-by-default middleware forces authentication (401 without a valid
// token); intentionally NOT added to PUBLIC_API_PATHS.
app.get('/api/my-history', async (req, res) => {
  // Staging-only, read-only demo injection so a reviewer (whose own wallet
  // matches no seeded round) still sees a populated tab. Never persists; no-op
  // in production.
  if (IS_STAGING && req.query.demo === '1') {
    return res.json({
      results: STAGING_DEMO_RESULTS,
      stats: computeHistoryStats(STAGING_DEMO_RESULTS),
      demo: true,
    });
  }

  const pubkey = req.user && req.user.usernode_pubkey;
  if (!pubkey) {
    // Signed in but no linked wallet → no on-chain guesses to match.
    return res.json({ results: [], stats: { played: 0, wins: 0, winRate: 0 } });
  }

  const derived = collectUserResults(pubkey);
  let results = derived;

  if (db.isEnabled()) {
    try {
      await db.upsertResults(req.user, derived);
      const persisted = await db.getResultsForUser(req.user.id);
      if (persisted) results = persisted;
    } catch (e) {
      // Degrade to freshly-derived (unsaved) results rather than 500-ing.
      if (!dbWarned) {
        console.error('[my-history] DB unavailable, serving derived results:', e.message);
        dbWarned = true;
      }
    }
  }

  res.json({ results, stats: computeHistoryStats(results) });
});

// Signed-in Usernode account identity, surfaced to the header badge. Under
// /api/ so the deny-by-default middleware 401s without a valid token (NOT in
// PUBLIC_API_PATHS) — the frontend treats that as "no identity" and hides the
// badge. Returns only the three already-public identity fields from req.user;
// never echoes the raw token or any other JWT claims.
app.get('/api/me', (req, res) => {
  // Staging-only demo parity: reviewers exercising ?demo=1 (whose JWT is their
  // own account) still see a populated badge and the "no wallet linked" path.
  // No-op in production.
  if (IS_STAGING && req.query.demo === '1') {
    const { id, username, usernode_pubkey } = STAGING_DEMO_USER;
    return res.json({ authenticated: true, id, username, usernode_pubkey, demo: true });
  }

  const { id, username, usernode_pubkey } = req.user;
  res.json({ authenticated: true, id, username, usernode_pubkey });
});

const VALID_TRACKS = new Set(['1h', '6h', '1d', '1w']);

// Admin: set difficulty for a specific track's next round
app.post('/__numguess/admin/set-mode', (req, res) => {
  const { track, difficulty } = req.body || {};
  if (!VALID_TRACKS.has(track)) {
    return res.status(400).json({ error: 'Invalid track. Must be one of: 1h, 6h, 1d, 1w' });
  }
  if (!DIFFICULTIES[difficulty]) {
    return res.status(400).json({ error: 'Invalid difficulty. Must be one of: easy, medium, hard' });
  }
  pendingDifficulty[track] = difficulty;
  console.log('[admin] pendingDifficulty updated:', pendingDifficulty);
  res.json({ ok: true, pendingDifficulty });
});

// Admin: manually start a new round for a specific track
app.post('/__numguess/admin/start', async (req, res) => {
  const { track } = req.body || {};
  if (!VALID_TRACKS.has(track)) {
    return res.status(400).json({ error: 'Invalid track. Must be one of: 1h, 6h, 1d, 1w' });
  }
  try {
    await postStartRound(track);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mock-enabled probe — the hosted bridge probes this on startup to decide
// whether to route sendTransaction through a local mock layer. This app has
// no mock layer; it runs exclusively in live Usernode DApps mode.
//
// CRITICAL bridge contract: the bridge keys its decision off the HTTP STATUS
// only (it does `_mockEnabledResult = resp.ok` and ignores the body). A 2xx —
// even one whose body says `{enabled:false}` — tells the bridge mock mode is
// ON, so it routes every guess to the nonexistent `/__mock/sendTransaction`
// and the send fails with "Mock API not enabled". We therefore answer with a
// non-2xx status so `isMockEnabled()` resolves false and sendTransaction stays
// on the real network path (native wallet in-app, QR on desktop).
//
// This explicit handler must also stay rather than letting the request fall
// through to the `app.get('*')` catch-all below, which would serve index.html
// with a 200 to authenticated probes and re-enable mock mode. 404 = "this mock
// endpoint does not exist here."
//
// NOTE: the resulting `GET /__mock/enabled 404` line in the browser console is
// EXPECTED and produced by the hosted bridge's own probe fetch — not app code,
// and not suppressible from here. Do NOT "fix" it by returning 2xx or deleting
// this route; either would re-enable mock mode and break Place Guess.
app.get('/__mock/enabled', (_req, res) => res.status(404).json({ enabled: false }));

// Favicon — serve as SVG so the browser stops logging 401s for this automatic request
const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🎯</text></svg>';
app.get('/favicon.ico', (_req, res) => {
  res.set('content-type', 'image/svg+xml').set('cache-control', 'public, max-age=86400').send(FAVICON_SVG);
});

// Static assets — index:false so index.html is gated by JWT in the catch-all below
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// HTML shell — gated by JWT
app.get('*', (req, res) => {
  if (!req.user) {
    // Distinguish "never authenticated" from "session was rejected" so the
    // gate page tells the truth instead of always implying a direct visit.
    const rejected = req.authError === 'expired' || req.authError === 'invalid';
    const title = rejected ? 'Session expired' : 'Open this app inside Usernode';
    const heading = rejected ? 'Your session expired' : 'Open this app inside Usernode';
    const body = rejected
      ? 'Reopen the app from Usernode to continue — your sign-in needs to be refreshed.'
      : "This page is served via the platform; direct visits aren't authenticated.";
    const cta = rejected ? 'Reopen from Usernode' : 'Go to Usernode';
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>${title}</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">${heading}</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">${body}</p>
    <a href="https://social-vibecoding.usernodelabs.org" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">${cta}</a>
  </div>
</body>`);
  }
  res.set('cache-control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function start() {
  // Fail loud if the session-signing secret is missing. Without it the auth
  // middleware can never set req.user, so every shell load hits the gate page
  // and login is totally broken. In staging/build the secret is platform-
  // injected and absent in PR previews, so only warn there; in production a
  // missing secret is a hard misconfiguration.
  if (!JWT_SECRET) {
    if (IS_STAGING) {
      console.warn('[boot] JWT_SECRET is not set — auth will reject all sessions. Expected in some staging/preview builds.');
    } else {
      console.error('[boot] FATAL: JWT_SECRET is not set in production — login is broken until it is configured. All sessions will be rejected.');
    }
  }

  // Live gameplay (rounds, guesses, scores, win streaks) is derived from
  // on-chain transactions. Postgres holds only the durable per-user game
  // history projection; apply its schema idempotently before serving.
  try {
    await db.initSchema();
    // One-off cleanup: clear any persisted history rows for blocked players.
    // Public surfaces are filtered live in game-logic; this only tidies the
    // blocked player's own My Games projection. Pubkeys resolve lazily from the
    // usernames cache after start, so seed the purge with the configured names.
    await db.purgeHiddenUsers({
      usernames: hidden.hiddenUsernames,
      pubkeys: hidden.hiddenPubkeys,
    });
  } catch (e) {
    console.error('[boot] game_results schema init failed (history persistence degraded):', e.message);
  }

  if (IS_STAGING) {
    injectStagingSeeds();
    // Seed the demo player's saved history so the My Games tab is populated in
    // staging review. Idempotent; serves the same rows the ?demo=1 path returns.
    try {
      await db.upsertResults(STAGING_DEMO_USER, STAGING_DEMO_RESULTS);
    } catch (e) {
      console.warn('[staging] demo game_results seed skipped:', e.message);
    }
  }

  await numguessCache.start();
  await usernamesCache.start();
  nodeStatusProbe.start();

  // Prime the usernames snapshot so the hide-the-unnamed predicate is correct
  // even for any state derivation that happens before the first public read.
  syncHiddenFromUsernames();

  // After stream backfill, ensure all 4 tracks have an active round
  setTimeout(async () => {
    // Configure the wallet signer up front so the first start_round send below
    // has a signer (the failure that previously blocked auto-start). Best-effort:
    // a failure here just retries lazily on the next send via ensureSignerConfigured.
    if (APP_SECRET_KEY) {
      try { await ensureSignerConfigured(); }
      catch (e) { console.error('[boot] signer configure failed (will retry on next send):', e.message); }
    }
    for (const track of TRACKS) {
      const current = game.getCurrentRoundForTrack(track);
      if (!current) {
        if (APP_SECRET_KEY) {
          postStartRound(track).catch((e) => console.error(`[boot:${track}] failed to create initial round:`, e.message));
        } else if (IS_STAGING) {
          try { await postStartRound(track); } catch (e) { console.error(`[boot:${track}] failed:`, e.message); }
        } else {
          console.warn(`[boot:${track}] APP_SECRET_KEY not set and not staging — skipping auto round creation`);
        }
      }
    }
  }, 500);

  // Round lifecycle check every 5s for all tracks
  setInterval(() => {
    for (const track of TRACKS) {
      checkTrack(track).catch((e) => console.error(`[checkTrack:${track}]`, e.message));
    }
  }, 5000);

  app.listen(port, () => console.log(`Number Guessing Game listening on :${port}`));
}

start().catch((err) => { console.error(err); process.exit(1); });
