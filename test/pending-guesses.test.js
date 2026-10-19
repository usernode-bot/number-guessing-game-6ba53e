'use strict';

// Route tests for the pending-guess persistence endpoints (POST/GET/DELETE
// /api/pending-guess[es]) — the refresh-safety cache for in-flight guesses.
//
// server.js only boots (listen/poll/on-chain side effects) under
// `require.main === module`, so requiring it here wires up the routes + caches
// inertly. We then mount `srv.app` on an ephemeral port and drive it over HTTP
// with a signed JWT, asserting auth, validation, the DB-disabled degrade path,
// and the staging ?demo=1 seed. DB-backed filtering/pruning is covered by
// test/pending-guesses-db.test.js (guarded on a test database).
//
// Run: `node test/pending-guesses.test.js` (or `npm test`).

const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');
const jwt = require('jsonwebtoken');

// Deterministic, inert boot: no DB (exercise the degrade path), a throwaway
// RS256 keypair matching server.js's verify options so we can sign tokens, and
// STAGING so the ?demo=1 branch is live. server.js reads the key at module
// load, so the env must be set before the require below.
delete process.env.DATABASE_URL;
delete process.env.APP_SECRET_KEY;
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
process.env.USERNODE_JWT_PUBLIC_KEY = publicKey;
process.env.USERNODE_APP_ID = 'numguess-test';
process.env.USERNODE_ENV = 'staging';

const srv = require('../server.js');

const APP_PUBKEY = process.env.APP_PUBKEY || 'ut1p0p7y8ujacndc60r4a7pzk45dufdtarp6satvc0md7866633u8sqagm3az';
const ACCOUNT = 'utpk1pendtestaccountaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaacc01';
const LIVE_ROUND = 500001;

// Inject a LIVE (never-ended) 1h round with a recent start so its active window
// is still open — getCurrentRoundForTrack('1h') must return it.
srv.numguessCache.injectSeedTransactions([
  { id: 't-pend-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: LIVE_ROUND, seed_hash: '00000031' + 'b'.repeat(56), active_duration_ms: 3600000, min_players: 1, max_guesses_per_player: 10, mode: 'normal', duration_track: '1h', difficulty: 'medium' }), timestamp_ms: Date.now() - 60000 },
]);

const token = jwt.sign(
  { id: 'pending-test-user', username: 'pend_s', usernode_pubkey: ACCOUNT, pur: 'iframe' },
  privateKey,
  { algorithm: 'RS256', issuer: 'usernode', audience: 'usernode:app:numguess-test' }
);

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log('  ok  -', name); }
  catch (e) { failures++; console.error('  FAIL -', name, '\n      ', e.message); }
}

// Minimal HTTP helper against the mounted app.
function request(server, method, path, { body, auth } = {}) {
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

(async () => {
  const server = http.createServer(srv.app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  // --- auth (deny-by-default on /api/*) ---
  await check('POST without a token is 401', async () => {
    const res = await request(server, 'POST', '/api/pending-guess', { body: { round: LIVE_ROUND, guess: 50 } });
    assert.strictEqual(res.status, 401);
  });
  await check('GET without a token is 401', async () => {
    const res = await request(server, 'GET', '/api/pending-guesses');
    assert.strictEqual(res.status, 401);
  });
  await check('DELETE without a token is 401', async () => {
    const res = await request(server, 'DELETE', '/api/pending-guess', { body: { round: LIVE_ROUND, guess: 50 } });
    assert.strictEqual(res.status, 401);
  });

  // --- POST validation ---
  await check('POST a valid live-round guess returns ok (DB disabled → no store)', async () => {
    const res = await request(server, 'POST', '/api/pending-guess', { body: { round: LIVE_ROUND, guess: 50 }, auth: token });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json, { ok: true });
  });
  await check('POST for a non-existent / inactive round is 409', async () => {
    const res = await request(server, 'POST', '/api/pending-guess', { body: { round: 424242, guess: 50 }, auth: token });
    assert.strictEqual(res.status, 409);
  });
  await check('POST an out-of-range guess is 400', async () => {
    const res = await request(server, 'POST', '/api/pending-guess', { body: { round: LIVE_ROUND, guess: 9999 }, auth: token });
    assert.strictEqual(res.status, 400);
  });
  await check('POST missing round/guess is 400', async () => {
    const res = await request(server, 'POST', '/api/pending-guess', { body: {}, auth: token });
    assert.strictEqual(res.status, 400);
  });

  // --- GET degrade path (DB disabled) ---
  await check('GET returns an empty list when persistence is disabled', async () => {
    const res = await request(server, 'GET', '/api/pending-guesses', { auth: token });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json, { pending: [] });
  });

  // --- DELETE degrade path ---
  await check('DELETE returns ok even when persistence is disabled', async () => {
    const res = await request(server, 'DELETE', '/api/pending-guess', { body: { round: LIVE_ROUND, guess: 50 }, auth: token });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json, { ok: true });
  });

  // --- staging ?demo=1 seed (IS_STAGING is true in this test) ---
  await check('GET ?demo=1 surfaces the fake pending guess for the live 1h round', async () => {
    const res = await request(server, 'GET', '/api/pending-guesses?demo=1', { auth: token });
    assert.strictEqual(res.status, 200);
    assert.ok(res.json && res.json.demo === true, 'response should be flagged demo');
    assert.strictEqual(res.json.pending.length, 1);
    assert.strictEqual(res.json.pending[0].roundId, LIVE_ROUND);
    assert.strictEqual(res.json.pending[0].guess, 88);
    assert.strictEqual(res.json.pending[0].track, '1h');
  });

  await new Promise((r) => server.close(r));

  if (failures) {
    console.error(`\n${failures} pending-guess route test(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll pending-guess route tests passed.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
