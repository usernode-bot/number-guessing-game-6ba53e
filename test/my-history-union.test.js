'use strict';

// Unit test for the My Games wallet/JWT union read-back fix.
//
// A guess tx is signed by the player's WALLET, whose pubkey is not guaranteed to
// equal the JWT account pubkey. Before the fix, /api/my-history derived results
// from the JWT pubkey alone, so a player whose two identities differ saw an empty
// history despite real on-chain play. The fix derives from the UNION of both.
//
// server.js only boots (listen/poll/on-chain) under `require.main === module`, so
// requiring it here wires up the helpers + caches inertly. We inject a finished
// round signed by a wallet that is NOT the account pubkey and assert the union
// surfaces it while the account pubkey alone does not.
//
// Run: `node test/my-history-union.test.js` (or `npm test`).

const assert = require('node:assert');

// Keep the required module fully inert: no DB, no on-chain signer, not staging.
delete process.env.DATABASE_URL;
delete process.env.APP_SECRET_KEY;
delete process.env.USERNODE_ENV;

const srv = require('../server.js');

const WALLET = 'utpk1testwalletwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwtest01';
const ACCOUNT = 'utpk1testaccountaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaacc01';
const ROUND = 999001;
const APP_PUBKEY = process.env.APP_PUBKEY || 'ut1p0p7y8ujacndc60r4a7pzk45dufdtarp6satvc0md7866633u8sqagm3az';

// Inject a finished round whose two guesses are signed by WALLET (not ACCOUNT).
srv.numguessCache.injectSeedTransactions([
  { id: 't-union-start', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'start_round', round: ROUND, seed_hash: '00000031' + 'a'.repeat(56), active_duration_ms: 86400000, min_players: 1, max_guesses_per_player: 5, mode: 'normal', duration_track: '1d', difficulty: 'medium' }), timestamp_ms: 1000 },
  { id: 't-union-g1', to: APP_PUBKEY, from_pubkey: WALLET, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: ROUND, guess: 50 }), timestamp_ms: 1100 },
  { id: 't-union-g2', to: APP_PUBKEY, from_pubkey: WALLET, amount: 1, memo: JSON.stringify({ app: 'numguess', type: 'guess', round: ROUND, guess: 55 }), timestamp_ms: 1200 },
  { id: 't-union-end', to: APP_PUBKEY, from_pubkey: APP_PUBKEY, amount: 0, memo: JSON.stringify({ app: 'numguess', type: 'end_round', round: ROUND, secret: 50, winner: WALLET, winner_guess: 50, pot: 2, participants: 1 }), timestamp_ms: 2000 },
]);

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok  -', name); }
  catch (e) { failures++; console.error('  FAIL -', name, '\n      ', e.message); }
}

// --- validateWalletPubkey ---
check('validateWalletPubkey accepts a normal pubkey', () => {
  assert.strictEqual(srv.validateWalletPubkey(WALLET), WALLET);
});
check('validateWalletPubkey trims surrounding whitespace', () => {
  assert.strictEqual(srv.validateWalletPubkey('  ' + WALLET + '  '), WALLET);
});
check('validateWalletPubkey rejects empty / non-string', () => {
  assert.strictEqual(srv.validateWalletPubkey(''), null);
  assert.strictEqual(srv.validateWalletPubkey(null), null);
  assert.strictEqual(srv.validateWalletPubkey(42), null);
});
check('validateWalletPubkey rejects injection-y / oversized input', () => {
  assert.strictEqual(srv.validateWalletPubkey('abc; DROP TABLE'), null);
  assert.strictEqual(srv.validateWalletPubkey('x'.repeat(129)), null);
});

// --- union derivation ---
check('the account pubkey ALONE does not find the wallet-signed round', () => {
  const r = srv.deriveUnionResults([ACCOUNT]);
  assert.ok(!r.some((x) => x.round_id === ROUND), 'round should not appear for account-only');
});
check('the wallet finds its own round', () => {
  const r = srv.deriveUnionResults([WALLET]);
  const row = r.find((x) => x.round_id === ROUND);
  assert.ok(row, 'round must appear for the signing wallet');
  assert.strictEqual(row.won, true);
  assert.strictEqual(row.best_guess, 50);
  assert.strictEqual(row.best_distance, 0);
});
check('the UNION of account + wallet surfaces the round', () => {
  const r = srv.deriveUnionResults([ACCOUNT, WALLET]);
  assert.ok(r.some((x) => x.round_id === ROUND), 'union must include the wallet-signed round');
});
check('union dedupes a repeated identity (no double-count)', () => {
  const r = srv.deriveUnionResults([WALLET, WALLET]);
  assert.strictEqual(r.filter((x) => x.round_id === ROUND).length, 1);
});
check('union guesses returns each individual guess once', () => {
  const g = srv.deriveUnionGuesses([ACCOUNT, WALLET]).filter((x) => x.round_id === ROUND);
  assert.strictEqual(g.length, 2);
  assert.deepStrictEqual(g.map((x) => x.guess).sort((a, b) => a - b), [50, 55]);
});

// --- historyPubkeys request shaping ---
check('historyPubkeys unions JWT pubkey with a validated ?wallet hint', () => {
  const keys = srv.historyPubkeys({ user: { usernode_pubkey: ACCOUNT }, query: { wallet: WALLET }, headers: {} });
  assert.deepStrictEqual(keys, [ACCOUNT, WALLET]);
});
check('historyPubkeys reads the wallet from a header too', () => {
  const keys = srv.historyPubkeys({ user: { usernode_pubkey: ACCOUNT }, query: {}, headers: { 'x-usernode-wallet': WALLET } });
  assert.deepStrictEqual(keys, [ACCOUNT, WALLET]);
});
check('historyPubkeys collapses identical account+wallet to one', () => {
  const keys = srv.historyPubkeys({ user: { usernode_pubkey: WALLET }, query: { wallet: WALLET }, headers: {} });
  assert.deepStrictEqual(keys, [WALLET]);
});
check('historyPubkeys ignores an invalid wallet hint', () => {
  const keys = srv.historyPubkeys({ user: { usernode_pubkey: ACCOUNT }, query: { wallet: 'bad; value' }, headers: {} });
  assert.deepStrictEqual(keys, [ACCOUNT]);
});

if (failures) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log('\nAll my-history union tests passed.');
process.exit(0);
