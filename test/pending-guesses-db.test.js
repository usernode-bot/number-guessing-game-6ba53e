'use strict';

// Unit tests for the pending_guesses db helpers in lib/db.js:
//   upsertPendingGuess (idempotent by user_id+round_id+guess),
//   getPendingGuessesForUser (shape + epoch-ms placed_at),
//   deletePendingGuess.
//
// GUARDED: these need a real Postgres. They run only when TEST_DATABASE_URL (or
// DATABASE_URL) points at a throwaway database; otherwise they SKIP cleanly with
// exit 0 so `npm test` stays green in environments without a test DB (the same
// convention the platform's staging/CI runs under).
//
// Run: `TEST_DATABASE_URL=postgres://… node test/pending-guesses-db.test.js`

const assert = require('node:assert');

const TEST_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!TEST_URL) {
  console.log('[pending-guesses-db] no TEST_DATABASE_URL/DATABASE_URL set — skipping DB tests.');
  process.exit(0);
}
process.env.DATABASE_URL = TEST_URL;

const db = require('../lib/db');

const USER = { id: 'db-test-user-pending', username: 'dbpend_s', usernode_pubkey: 'utpk1dbpendaccount000000000000000000000000000000000000000db01' };
const ROUND = 700001;

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log('  ok  -', name); }
  catch (e) { failures++; console.error('  FAIL -', name, '\n      ', e.message); }
}

(async () => {
  assert.ok(db.isEnabled(), 'db should be enabled with a DATABASE_URL');
  await db.initSchema();

  // Clean slate for this user (idempotent; safe to re-run).
  await db.deletePendingGuess(USER.id, ROUND, 50);
  await db.deletePendingGuess(USER.id, ROUND, 55);

  await check('upsertPendingGuess inserts a row that getPendingGuessesForUser returns', async () => {
    await db.upsertPendingGuess(USER, { round_id: ROUND, track: '1h', difficulty: 'medium', guess: 50 });
    const rows = await db.getPendingGuessesForUser(USER.id);
    const mine = rows.filter((r) => r.roundId === ROUND);
    assert.strictEqual(mine.length, 1);
    const row = mine[0];
    assert.strictEqual(row.guess, 50);
    assert.strictEqual(row.track, '1h');
    assert.strictEqual(row.difficulty, 'medium');
    assert.strictEqual(row.status, 'pending');
    assert.strictEqual(typeof row.placedAt, 'number', 'placedAt is epoch-ms');
    assert.ok(row.placedAt > 0);
  });

  await check('upsertPendingGuess is idempotent by (user_id, round_id, guess)', async () => {
    await db.upsertPendingGuess(USER, { round_id: ROUND, track: '1h', difficulty: 'medium', guess: 50 });
    await db.upsertPendingGuess(USER, { round_id: ROUND, track: '1h', difficulty: 'medium', guess: 50 });
    const rows = await db.getPendingGuessesForUser(USER.id);
    assert.strictEqual(rows.filter((r) => r.roundId === ROUND && r.guess === 50).length, 1, 'no duplicate row');
  });

  await check('distinct guesses in the same round coexist (multi-guess rounds)', async () => {
    await db.upsertPendingGuess(USER, { round_id: ROUND, track: '1h', difficulty: 'medium', guess: 55 });
    const rows = await db.getPendingGuessesForUser(USER.id);
    const mine = rows.filter((r) => r.roundId === ROUND).map((r) => r.guess).sort((a, b) => a - b);
    assert.deepStrictEqual(mine, [50, 55]);
  });

  await check('deletePendingGuess removes only the targeted guess', async () => {
    await db.deletePendingGuess(USER.id, ROUND, 50);
    const rows = await db.getPendingGuessesForUser(USER.id);
    const mine = rows.filter((r) => r.roundId === ROUND).map((r) => r.guess);
    assert.deepStrictEqual(mine, [55]);
    await db.deletePendingGuess(USER.id, ROUND, 55);
    const after = (await db.getPendingGuessesForUser(USER.id)).filter((r) => r.roundId === ROUND);
    assert.strictEqual(after.length, 0);
  });

  if (failures) {
    console.error(`\n${failures} pending-guesses-db test(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll pending-guesses-db tests passed.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
