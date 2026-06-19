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

const APP_PUBKEY = process.env.APP_PUBKEY || 'utpk1rn7sakz2nvk2uzlvf4spzl22374z9u0jvah8yqs0djc722u96uqs20yx79';
const APP_SECRET_KEY = process.env.APP_SECRET_KEY || '';
const NODE_RPC_URL = process.env.NODE_RPC_URL || 'http://usernode-node:3000';
const TIMER_DURATION_MS = parseInt(process.env.TIMER_DURATION_MS || '86400000', 10);
const MIN_PLAYERS = parseInt(process.env.MIN_PLAYERS || '2', 10);
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const LOCAL_DEV = process.argv.includes('--local-dev');

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

const PUBLIC_API_PATHS = new Set(['/health', '/__numguess/state']);
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

  // Precomputed seed hashes where parseInt(hash.slice(0,8), 16) % 100 + 1 equals the target secret.
  // secret = 42: need x % 100 == 41. Use hex "00000029" = 41 in decimal.
  // secret = 75: need x % 100 == 74. Use hex "0000004a" = 74 in decimal.
  // secret = 23: need x % 100 == 22. Use hex "00000016" = 22 in decimal.
  const seedHashes = [
    '00000029aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0001',
    '0000004abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb0002',
    '00000016cccccccccccccccccccccccccccccccccccccccccccccccccccc0003',
    '0000007fdddddddddddddddddddddddddddddddddddddddddddddddddddd0004',
  ];

  const p1 = 'utpk1stagingplayer000000000000000000000000000000000000000001';
  const p2 = 'utpk1stagingplayer000000000000000000000000000000000000000002';
  const p3 = 'utpk1stagingplayer000000000000000000000000000000000000000003';

  const fakeTxs = [
    // Round 1 — secret 42 — alice_s wins with bullseye
    { id: 'staging-r1-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: 1, seed_hash: seedHashes[0], active_duration_ms: TIMER_DURATION_MS, min_players: MIN_PLAYERS }), timestamp_ms: now - 2 * day - 1000 },
    { id: 'staging-r1-g1', to: APP_PUBKEY, from_pubkey: p1, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 1, guess: 42 }), timestamp_ms: now - 2 * day + 100 },
    { id: 'staging-r1-g2', to: APP_PUBKEY, from_pubkey: p2, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 1, guess: 45 }), timestamp_ms: now - 2 * day + 200 },
    { id: 'staging-r1-g3', to: APP_PUBKEY, from_pubkey: p3, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 1, guess: 38 }), timestamp_ms: now - 2 * day + 300 },
    { id: 'staging-r1-end', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'end_round', round: 1, secret: 42, winner: p1, winner_guess: 42, pot: 3, participants: 3 }), timestamp_ms: now - 2 * day + TIMER_DURATION_MS },

    // Round 2 — secret 75 — bob_s wins with guess 74
    { id: 'staging-r2-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: 2, seed_hash: seedHashes[1], active_duration_ms: TIMER_DURATION_MS, min_players: MIN_PLAYERS }), timestamp_ms: now - day - 1000 },
    { id: 'staging-r2-g1', to: APP_PUBKEY, from_pubkey: p2, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 2, guess: 74 }), timestamp_ms: now - day + 100 },
    { id: 'staging-r2-g2', to: APP_PUBKEY, from_pubkey: p1, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 2, guess: 80 }), timestamp_ms: now - day + 200 },
    { id: 'staging-r2-g3', to: APP_PUBKEY, from_pubkey: p3, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 2, guess: 70 }), timestamp_ms: now - day + 300 },
    { id: 'staging-r2-end', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'end_round', round: 2, secret: 75, winner: p2, winner_guess: 74, pot: 4, participants: 4 }), timestamp_ms: now - day + TIMER_DURATION_MS },

    // Round 3 — secret 23 — carol_s wins with guess 25
    { id: 'staging-r3-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: 3, seed_hash: seedHashes[2], active_duration_ms: TIMER_DURATION_MS, min_players: MIN_PLAYERS }), timestamp_ms: now - 12 * 3600000 - 1000 },
    { id: 'staging-r3-g1', to: APP_PUBKEY, from_pubkey: p3, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 3, guess: 25 }), timestamp_ms: now - 12 * 3600000 + 100 },
    { id: 'staging-r3-g2', to: APP_PUBKEY, from_pubkey: p2, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 3, guess: 20 }), timestamp_ms: now - 12 * 3600000 + 200 },
    { id: 'staging-r3-g3', to: APP_PUBKEY, from_pubkey: p1, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 3, guess: 26 }), timestamp_ms: now - 12 * 3600000 + 300 },
    { id: 'staging-r3-end', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'end_round', round: 3, secret: 23, winner: p3, winner_guess: 25, pot: 3, participants: 3 }), timestamp_ms: now - 12 * 3600000 + TIMER_DURATION_MS },

    // Round 4 — current open round, alice_s has guessed 55
    { id: 'staging-r4-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: 4, seed_hash: seedHashes[3], active_duration_ms: TIMER_DURATION_MS, min_players: MIN_PLAYERS }), timestamp_ms: now - 2 * 3600000 },
    { id: 'staging-r4-g1', to: APP_PUBKEY, from_pubkey: p1, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: 4, guess: 55 }), timestamp_ms: now - 2 * 3600000 + 1000 },

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

// ---------------------------------------------------------------------------
// Payout logic
// ---------------------------------------------------------------------------

let inFlightPayout = false;
let payoutRetryTimer = null;

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

async function concludeRound(round) {
  if (inFlightPayout) return;
  inFlightPayout = true;

  try {
    const secret = game.computeSecret(round.seedHash);
    const result = game.findWinner(round);
    if (!result || !result.winner) {
      console.log('[payout] No valid guesses, skipping payout, starting next round');
      await postEndRound(round, secret, null, null, 0, round.guesses.length);
      await postStartRound();
      inFlightPayout = false;
      return;
    }

    const winner = result.winner.from;
    const pot = round.guesses.reduce((s, g) => s + g.amount, 0);

    console.log(`[payout] Round ${round.id}: secret=${secret}, winner=${winner}, pot=${pot}`);

    await configureSigner();

    // 1. Send payout to winner
    const payoutMemo = { app: 'numguess', type: 'payout', round: round.id, winner };
    await sendWithRetry(winner, pot, payoutMemo, 3);
    console.log('[payout] Payout sent to', winner);

    // 2. Post end_round self-transfer
    await postEndRound(round, secret, winner, result.winner.guess, pot, round.guesses.length);

    // 3. Start next round
    await postStartRound();
    inFlightPayout = false;
  } catch (e) {
    console.error('[payout] All retries failed:', e.message);
    inFlightPayout = false;
    if (payoutRetryTimer) clearTimeout(payoutRetryTimer);
    payoutRetryTimer = setTimeout(() => checkRound(), 60000);
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
  await sendWithRetry(APP_PUBKEY, 0, memo, 3);
  // Also inject locally so state updates immediately
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

let nextRoundId = 1;

async function postStartRound() {
  // Determine next round ID
  let maxId = 0;
  for (const [id] of game.rounds) {
    if (id > maxId) maxId = id;
  }
  const roundId = maxId + 1;
  nextRoundId = roundId;

  const seedHash = crypto.randomBytes(32).toString('hex');
  const memo = {
    app: 'numguess',
    type: 'start_round',
    round: roundId,
    seed_hash: seedHash,
    active_duration_ms: TIMER_DURATION_MS,
    min_players: MIN_PLAYERS,
  };

  await sendWithRetry(APP_PUBKEY, 0, memo, 3);
  // Also inject locally
  game.processTransaction({
    id: `local-start-${roundId}-${Date.now()}`,
    to: APP_PUBKEY,
    from_pubkey: APP_PUBKEY,
    amount: 0,
    memo: JSON.stringify(memo),
    timestamp_ms: Date.now(),
  });
  console.log(`[round] Started round ${roundId}`);
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
  // Update in memory immediately
  round.endsAt = newEndsAt;
  try {
    await sendWithRetry(APP_PUBKEY, 0, memo, 1);
  } catch (e) {
    console.warn('[round] extension memo post failed (continuing):', e.message);
  }
  console.log(`[round] Extended round ${round.id}, new endsAt=${new Date(newEndsAt).toISOString()}`);
}

async function checkRound() {
  if (!APP_SECRET_KEY) return;
  if (inFlightPayout) return;
  const currentRound = game.getCurrentRound();
  if (!currentRound) {
    // No round at all — create first one
    try { await postStartRound(); } catch (e) { console.error('[round] Failed to create initial round:', e.message); }
    return;
  }
  if (currentRound.endsAt > Date.now()) return; // not expired yet

  const participants = currentRound.guesses.length;
  if (participants >= currentRound.minPlayers) {
    await concludeRound(currentRound);
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

// Game state endpoint
app.get('/__numguess/state', (_req, res) => {
  if (!numguessCache.isStreamReady()) {
    res.json({ loading: true, appPubkey: APP_PUBKEY });
    return;
  }
  res.set('cache-control', 'no-store');
  res.json(game.getStateResponse());
});

// Admin: manually start a new round
app.post('/__numguess/admin/start', async (req, res) => {
  try {
    await postStartRound();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mock-enabled probe — always respond so the bridge doesn't fall through to the 401 catch-all
app.get('/__mock/enabled', (_req, res) => res.json({ enabled: !!mockApi }));

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
  if (IS_STAGING) {
    injectStagingSeeds();
  }

  await numguessCache.start();
  await usernamesCache.start();
  nodeStatusProbe.start();

  // Mark stream ready after backfill
  setTimeout(() => {
    const current = game.getCurrentRound();
    if (!current) {
      if (APP_PUBKEY && APP_SECRET_KEY) {
        postStartRound().catch((e) => console.error('[boot] failed to create initial round:', e.message));
      } else {
        console.warn('[boot] APP_PUBKEY/APP_SECRET_KEY not set — skipping auto round creation');
      }
    }
  }, 500);

  // Round lifecycle check every 5s
  setInterval(() => {
    checkRound().catch((e) => console.error('[checkRound]', e.message));
  }, 5000);

  app.listen(port, () => console.log(`Number Guessing Game listening on :${port}`));
}

start().catch((err) => { console.error(err); process.exit(1); });
