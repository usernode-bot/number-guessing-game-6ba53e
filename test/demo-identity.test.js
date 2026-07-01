'use strict';

// Regression test for the demo/staging "guess hangs on Placing… / guess-history
// list never populates" bug.
//
// In demo mode the client's `myAddress` MUST equal the address the staging
// server attributes demo guesses to (`STAGING_DEMO_ADDR` here, `DEMO_ADDR` in
// public/index.html). guessLanded() on the client keys on `from === myAddress`,
// so if the two constants ever drift apart, a placed demo guess never satisfies
// guessLanded() and the "My guesses this round" row hangs on "Placing…" forever
// — exactly the reported symptom. These two literals live in SEPARATE files, so
// nothing but a test keeps them in lockstep. Assert they match.
//
// (The client-side half of the fix — maybeActivateDemo() re-running the demo
// sign-in so myAddress is actually SET to DEMO_ADDR even after a non-demo
// init sign-in — is exercised by the browser proposal check
// "Multi-guess auto-guess CONFIRMS and populates the guess-history list".)
//
// Run: `node test/demo-identity.test.js` (or `npm test`).

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Keep the required module fully inert: no DB, no on-chain signer, not staging.
delete process.env.DATABASE_URL;
delete process.env.APP_SECRET_KEY;
delete process.env.USERNODE_ENV;

const srv = require('../server.js');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok  -', name); }
  catch (e) { failures++; console.error('  FAIL -', name, '\n      ', e.message); }
}

// Extract the client's DEMO_ADDR literal straight from the shipped HTML shell.
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const m = html.match(/const\s+DEMO_ADDR\s*=\s*'([^']+)'/);

check('the client HTML defines a DEMO_ADDR constant', () => {
  assert.ok(m, 'could not find `const DEMO_ADDR = \'…\'` in public/index.html');
});

check('client DEMO_ADDR === server STAGING_DEMO_ADDR (guessLanded match invariant)', () => {
  assert.ok(srv.STAGING_DEMO_ADDR, 'server must export STAGING_DEMO_ADDR');
  assert.strictEqual(
    m && m[1],
    srv.STAGING_DEMO_ADDR,
    'client DEMO_ADDR and server STAGING_DEMO_ADDR must be identical, or demo ' +
    'guesses never confirm (guessLanded keys on from === myAddress)'
  );
});

check('the client still re-establishes the demo identity when demo activates', () => {
  // Guard the maybeActivateDemo() fix from silently regressing back to the
  // "only sign in when !loggedIn" form that left myAddress on the real wallet.
  const fn = html.slice(html.indexOf('function maybeActivateDemo'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(
    /attemptSignIn\(\)/.test(body),
    'maybeActivateDemo() must call attemptSignIn() to force the demo identity'
  );
  assert.ok(
    !/if\s*\(\s*!loggedIn\s*\)\s*\{\s*attemptSignIn/.test(body),
    'maybeActivateDemo() must NOT gate the demo sign-in behind `if (!loggedIn)` ' +
    '— that leaves myAddress on the real wallet and demo guesses never confirm'
  );
});

if (failures) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log('\nAll demo-identity tests passed.');
process.exit(0);
