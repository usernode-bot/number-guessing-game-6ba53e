'use strict';

const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');

const {
  loadEnvFile,
  handleExplorerProxy,
  createAppStateCache,
  createUsernamesCache,
  createNodeStatusProbe,
  createMockApi,
  EXPLORER_PROXY_PREFIX,
} = require('./lib/dapp-server');
const { createGame } = require('./game-logic');

loadEnvFile();

const app = express();
const port = parseInt(process.env.PORT || '3000', 10);
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;
const JWT_SECRET = process.env.JWT_SECRET;

const APP_PUBKEY = 'utpk1rn7sakz2nvk2uzlvf4spzl22374z9u0jvah8yqs0djc722u96uqs20yx79';
const APP_SECRET_KEY = process.env.APP_SECRET_KEY || '';
const NODE_RPC_URL = process.env.NODE_RPC_URL || 'http://usernode-node:3000';
const TIMER_DURATION_MS = parseInt(process.env.TIMER_DURATION_MS || '86400000', 10);
const ROUND_TIMED_MS = parseInt(process.env.ROUND_TIMED_MS || '60000', 10);
const MIN_PLAYERS = parseInt(process.env.MIN_PLAYERS || '2', 10);
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const LOCAL_DEV = process.argv.includes('--local-dev');

const TRACKS = ['1h', '6h', '1d', '1w'];
const TRACK_DURATIONS = {
  '1h': 3600000,
  '6h': 21600000,
  '1d': TIMER_DURATION_MS,
  '1w': 604800000,
};

// Per-track pending hard mode config (resets to false after each round starts)
const pendingHardMode = { '1h': false, '6h': false, '1d': false, '1w': false };

// Per-track payout guards
const inFlightPayout = { '1h': false, '6h': false, '1d': false, '1w': false };

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

const PUBLIC_API_PATHS = new Set(['/health', '/__numguess/state', '/favicon.ico']);
const PUBLIC_PREFIXES = [
  EXPLORER_PROXY_PREFIX,
  '/__usernode/',
  '/__usernames/',
  '/usernode-bridge.js',
  '/usernode-loading.js',
  '/usernode-usernames.js',
];

app.use(express.json());

app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_SECRET) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch {}
  }
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

// ---------------------------------------------------------------------------
// Game setup
// ---------------------------------------------------------------------------

const game = createGame({ appPubkey: APP_PUBKEY, timerDurationMs: TIMER_DURATION_MS, minPlayers: MIN_PLAYERS });

const mockApi = LOCAL_DEV ? createMockApi({ appPubkey: APP_PUBKEY }) : null;

const numguessCache = createAppStateCache({
  name: 'numguess',
  appPubkey: APP_PUBKEY,
  queryField: 'recipient',
  processTransaction: game.processTransaction,
  nodeRpcUrl: NODE_RPC_URL,
  localDev: LOCAL_DEV,
  mockTransactions: mockApi ? mockApi.transactions : null,
});

const usernamesCache = createUsernamesCache({
  nodeRpcUrl: NODE_RPC_URL,
  localDev: LOCAL_DEV,
  mockTransactions: mockApi ? mockApi.transactions : null,
});

const nodeStatusProbe = createNodeStatusProbe({
  nodeRpcUrl: NODE_RPC_URL,
  localDev: LOCAL_DEV,
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

    // Round 8 — 1h — active (started 15min ago, expires in ~45min)
    { id: 'staging-r8-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: 8, seed_hash: activeHashes.r8, active_duration_ms: 3600000, min_players: MIN_PLAYERS, max_guesses_per_player: 10, mode: 'normal', duration_track: '1h' }), timestamp_ms: now - 15 * 60000 },
    { id: 'staging-r8-g1', to: APP_PUBKEY, from_pubkey: p1, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 8, guess: 50 }), timestamp_ms: now - 10 * 60000 },
    { id: 'staging-r8-g2', to: APP_PUBKEY, from_pubkey: p3, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 8, guess: 75 }), timestamp_ms: now - 8 * 60000 },

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

    // Staging usernames
    { id: 'staging-u1', to: 'ut1p0p7y8ujacndc60r4a7pzk45dufdtarp6satvc0md7866633u8sqagm3az', from_pubkey: p1, amount: 1, memo: JSON.stringify({ app: 'usernames', type: 'set_username', username: 'alice_s' }), timestamp_ms: now - 3 * day },
    { id: 'staging-u2', to: 'ut1p0p7y8ujacndc60r4a7pzk45dufdtarp6satvc0md7866633u8sqagm3az', from_pubkey: p2, amount: 1, memo: JSON.stringify({ app: 'usernames', type: 'set_username', username: 'bob_s' }), timestamp_ms: now - 3 * day },
    { id: 'staging-u3', to: 'ut1p0p7y8ujacndc60r4a7pzk45dufdtarp6satvc0md7866633u8sqagm3az', from_pubkey: p3, amount: 1, memo: JSON.stringify({ app: 'usernames', type: 'set_username', username: 'carol_s' }), timestamp_ms: now - 3 * day },
  ];

  for (const tx of fakeTxs) {
    game.processTransaction(tx);
  }
  console.log('[staging] Injected', fakeTxs.length, 'seed transactions');
}

async function seedStagingDb() {
  if (!pool) return;
  try {
    // Legacy streaks
    await pool.query(`
      INSERT INTO player_streaks (pubkey, current_streak, best_streak, updated_at)
      VALUES
        ('utpk1stagingplayer000000000000000000000000000000000000000001', 3, 5, 0),
        ('utpk1stagingplayer000000000000000000000000000000000000000002', 1, 2, 0),
        ('utpk1stagingplayer000000000000000000000000000000000000000003', 0, 1, 0)
      ON CONFLICT (pubkey) DO NOTHING
    `);
    // Per-track streaks
    await pool.query(`
      INSERT INTO player_track_streaks (pubkey, track, current_streak, best_streak, updated_at)
      VALUES
        ('utpk1stagingplayer000000000000000000000000000000000000000001', '1h', 2, 3, 0),
        ('utpk1stagingplayer000000000000000000000000000000000000000001', '6h', 1, 2, 0),
        ('utpk1stagingplayer000000000000000000000000000000000000000001', '1d', 3, 5, 0),
        ('utpk1stagingplayer000000000000000000000000000000000000000001', '1w', 0, 1, 0),
        ('utpk1stagingplayer000000000000000000000000000000000000000002', '1h', 0, 1, 0),
        ('utpk1stagingplayer000000000000000000000000000000000000000002', '6h', 0, 1, 0),
        ('utpk1stagingplayer000000000000000000000000000000000000000002', '1d', 1, 2, 0),
        ('utpk1stagingplayer000000000000000000000000000000000000000002', '1w', 0, 1, 0),
        ('utpk1stagingplayer000000000000000000000000000000000000000003', '1h', 0, 1, 0),
        ('utpk1stagingplayer000000000000000000000000000000000000000003', '6h', 1, 1, 0),
        ('utpk1stagingplayer000000000000000000000000000000000000000003', '1d', 0, 1, 0),
        ('utpk1stagingplayer000000000000000000000000000000000000000003', '1w', 0, 0, 0)
      ON CONFLICT (pubkey, track) DO NOTHING
    `);
    console.log('[staging] Seeded player_streaks and player_track_streaks');
  } catch (e) {
    console.error('[staging] seedStagingDb error:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Streak helpers
// ---------------------------------------------------------------------------

async function updateStreaks(winnerPubkey, participantPubkeys, track) {
  if (!pool) return;
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (winnerPubkey) {
        await client.query(
          `INSERT INTO player_track_streaks (pubkey, track, current_streak, best_streak, updated_at)
           VALUES ($1, $2, 1, 1, $3)
           ON CONFLICT (pubkey, track) DO UPDATE SET
             current_streak = player_track_streaks.current_streak + 1,
             best_streak = GREATEST(player_track_streaks.best_streak, player_track_streaks.current_streak + 1),
             updated_at = $3`,
          [winnerPubkey, track, Date.now()]
        );
      }
      const losers = participantPubkeys.filter((p) => p !== winnerPubkey);
      for (const loser of losers) {
        await client.query(
          `INSERT INTO player_track_streaks (pubkey, track, current_streak, best_streak, updated_at)
           VALUES ($1, $2, 0, 0, $3)
           ON CONFLICT (pubkey, track) DO UPDATE SET
             current_streak = 0,
             updated_at = $3`,
          [loser, track, Date.now()]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('[streaks] update failed:', e.message);
  }
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
  await fetch(`${NODE_RPC_URL}/wallet/signer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secretKey: APP_SECRET_KEY }),
    signal: AbortSignal.timeout(10000),
  });
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
    const secret = game.computeSecret(round.seedHash);
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
      await configureSigner();

      // 1. Send payout to winner
      const payoutMemo = { app: 'numguess', type: 'payout', round: round.id, winner };
      await sendWithRetry(winner, pot, payoutMemo, 3);
      console.log(`[payout:${track}] Payout sent to`, winner);
    } else {
      console.log(`[payout:${track}] No APP_SECRET_KEY — skipping token payout (staging/dev mode)`);
    }

    // 2. Post end_round self-transfer (or inject locally in staging)
    await postEndRound(round, secret, winner, result.winner.guess, pot, round.guesses.length);

    // 3. Update per-track streaks
    const allParticipants = [...new Set(round.guesses.map((g) => g.from))];
    await updateStreaks(winner, allParticipants, track);

    // 4. Start next round for same track
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
    await sendWithRetry(APP_PUBKEY, 0, memo, 3);
  }
  // Always inject locally so state updates immediately (only real path in staging)
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
  const isHard = !!pendingHardMode[track];
  pendingHardMode[track] = false; // consume config, reset to default

  const maxGuessesPerPlayer = isHard ? 5 : 10;
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
  };

  if (APP_SECRET_KEY) {
    await sendWithRetry(APP_PUBKEY, 0, memo, 3);
  }
  // Always inject locally (only real path in staging)
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

// Bridge proxy — centrally hosted, never vendored
app.get('/usernode-bridge.js', (_req, res) => {
  const url = 'https://social-vibecoding.usernodelabs.org/usernode-bridge/v1/bridge.js';
  fetch(url, { signal: AbortSignal.timeout(8000) })
    .then((r) => {
      if (!r.ok) throw new Error('upstream ' + r.status);
      res.set('content-type', 'application/javascript');
      res.set('cache-control', 'no-cache, must-revalidate');
      return r.text();
    })
    .then((text) => res.send(text))
    .catch((e) => {
      console.error('[bridge proxy]', e.message);
      res.status(502).send('// bridge unavailable\n');
    });
});

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

// Mock API (local dev only)
if (mockApi) {
  app.use((req, res, next) => {
    if (mockApi.handleRequest(req, res, req.path)) return;
    next();
  });
}

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
    res.json({ loading: true, appPubkey: APP_PUBKEY });
    return;
  }
  res.set('cache-control', 'no-store');
  const state = game.getStateResponse();
  state.pendingHardMode = { ...pendingHardMode };

  if (pool && req.user && req.user.usernode_pubkey) {
    try {
      const r = await pool.query(
        'SELECT track, current_streak, best_streak FROM player_track_streaks WHERE pubkey = $1',
        [req.user.usernode_pubkey]
      );
      const myStreaks = {
        '1h': { currentStreak: 0, bestStreak: 0 },
        '6h': { currentStreak: 0, bestStreak: 0 },
        '1d': { currentStreak: 0, bestStreak: 0 },
        '1w': { currentStreak: 0, bestStreak: 0 },
      };
      for (const row of r.rows) {
        if (myStreaks[row.track]) {
          myStreaks[row.track] = { currentStreak: row.current_streak, bestStreak: row.best_streak };
        }
      }
      state.myStreaks = myStreaks;
    } catch (e) {
      console.error('[streaks] state query:', e.message);
    }
  }

  res.json(state);
});

const VALID_TRACKS = new Set(['1h', '6h', '1d', '1w']);

// Admin: set hard mode for a specific track's next round
app.post('/__numguess/admin/set-mode', (req, res) => {
  const { track, hardMode } = req.body || {};
  if (!VALID_TRACKS.has(track)) {
    return res.status(400).json({ error: 'Invalid track. Must be one of: 1h, 6h, 1d, 1w' });
  }
  pendingHardMode[track] = !!hardMode;
  console.log('[admin] pendingHardMode updated:', pendingHardMode);
  res.json({ ok: true, pendingHardMode });
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

// Mock-enabled probe — always respond so the bridge doesn't fall through to the 401 catch-all
app.get('/__mock/enabled', (_req, res) => res.json({ enabled: !!mockApi }));

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
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Usernode</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Usernode</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="https://social-vibecoding.usernodelabs.org" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Go to Usernode</a>
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
  // DB migrations
  if (pool) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS player_streaks (
          pubkey         TEXT    PRIMARY KEY,
          current_streak INTEGER NOT NULL DEFAULT 0,
          best_streak    INTEGER NOT NULL DEFAULT 0,
          updated_at     BIGINT  NOT NULL DEFAULT 0
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS player_track_streaks (
          pubkey          TEXT    NOT NULL,
          track           TEXT    NOT NULL,
          current_streak  INTEGER NOT NULL DEFAULT 0,
          best_streak     INTEGER NOT NULL DEFAULT 0,
          updated_at      BIGINT  NOT NULL DEFAULT 0,
          PRIMARY KEY (pubkey, track)
        )
      `);
      // Migrate existing player_streaks → player_track_streaks as '1d' track
      await pool.query(`
        INSERT INTO player_track_streaks (pubkey, track, current_streak, best_streak, updated_at)
        SELECT pubkey, '1d', current_streak, best_streak, updated_at
        FROM player_streaks
        ON CONFLICT (pubkey, track) DO NOTHING
      `);
      console.log('[db] player_streaks and player_track_streaks tables ready');
    } catch (e) {
      console.error('[db] migration error:', e.message);
    }
  }

  if (IS_STAGING) {
    injectStagingSeeds();
    await seedStagingDb();
  }

  await numguessCache.start();
  await usernamesCache.start();
  nodeStatusProbe.start();

  // After stream backfill, ensure all 4 tracks have an active round
  setTimeout(async () => {
    for (const track of TRACKS) {
      const current = game.getCurrentRoundForTrack(track);
      if (!current) {
        if (APP_SECRET_KEY) {
          postStartRound(track).catch((e) => console.error(`[boot:${track}] failed to create initial round:`, e.message));
        } else if (IS_STAGING || LOCAL_DEV) {
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
