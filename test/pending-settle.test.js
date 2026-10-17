'use strict';

// Unit test for the "guess stuck on Placing… until reload" fix (issue #63).
//
// Root cause being pinned: reconcilePendingGuesses() only ever ran inside
// render(), and render() only ran after a SUCCESSFUL state poll — so when
// /__numguess/state failed, the 90-second age-out never executed and the dimmed
// "Placing…" row sat there forever. Entries restored after a reload never had a
// background reconcile watching them at all, so they never reached 'timeout'.
//
// The fix, asserted here:
//   - a still-'pending' entry older than PENDING_SETTLE_MS (60s) flips to
//     'timeout', clears the server's persisted copy (DELETE /api/pending-guess)
//     and surfaces the "Hang tight" hint — even when the polls are failing
//     (settlePendingGuesses runs against the last known gameState);
//   - the existing 90-second TTL still drops the row, with a re-render;
//   - confirmation and the background-reconcile timeout also clear the
//     server's persisted copy, so a reload can't resurrect a settled row;
//   - DEMO mode is untouched (no flip, no DELETE).
//
// The needed functions are pulled out of public/index.html by name (brace
// matching) and run in node:vm with stubbed DOM/fetch globals and a
// controllable Date.now — the same technique test/demo-identity.test.js uses
// for reading the shipped client, but executing instead of pattern-matching.
//
// Run: `node test/pending-settle.test.js` (or `npm test`).

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// Extract a top-level function declaration by name using brace matching.
function extractFn(name) {
  const marker = 'function ' + name + '(';
  const start = html.indexOf(marker);
  assert.ok(start >= 0, 'function ' + name + ' not found in public/index.html');
  const bodyStart = html.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < html.length; i++) {
    const c = html[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return html.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces extracting ' + name);
}

// Extract a `const NAME = …;` declaration verbatim.
function extractConst(name) {
  const m = html.match(new RegExp('const\\s+' + name + '\\s*=[^;\\n]+;'));
  assert.ok(m, 'const ' + name + ' not found in public/index.html');
  return m[0];
}

const script = [
  extractConst('PENDING_TIMEOUT_TTL_MS'),
  extractConst('PENDING_MAX_AGE_MS'),
  extractConst('PENDING_SETTLE_MS'),
  extractFn('removePendingGuess'),
  extractFn('clearPendingGuess'),
  extractFn('showGuessTimeoutHint'),
  extractFn('applyOptimisticGuess'),
  extractFn('markGuessConfirmed'),
  extractFn('reconcilePendingGuesses'),
  extractFn('settlePendingGuesses'),
].join('\n\n');

const HINT = 'Hang tight — this is taking a moment to confirm. It may still go through; check back shortly. 🌿';
const BASE_T = 1700000000000;

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok  -', name); }
  catch (e) { failures++; console.error('  FAIL -', name, '\n      ', e.message); }
}

// Build a vm sandbox around the extracted client code. `now` is controllable so
// the timing backstops can be driven without real waits.
function makeSandbox(opts) {
  opts = opts || {};
  const calls = { deletes: [], errors: [], renders: 0 };
  let now = BASE_T;
  const ctx = {
    // client globals the extracted code closes over
    DEMO: !!opts.demo,
    myAddress: 'utpk1testplayer0000000000000000000000000000000000000000test01',
    selectedTrack: '1d',
    TRACKS: ['1h', '6h', '1d', '1w'],
    demoGuesses: [],
    pendingGuesses: [],
    gameState: {
      tracks: {
        '1d': { currentRound: { id: 'r1', guesses: [] } },
      },
    },
    // stubbed environment
    Date: { now: () => now },
    fetch: (url, o) => {
      if (o && o.method === 'DELETE') {
        calls.deletes.push({ url: String(url), body: JSON.parse(o.body) });
      }
      return Promise.resolve({ ok: true });
    },
    document: { getElementById: () => ({ classList: { add() {}, remove() {} } }) },
    window: {},
    showError: (msg) => calls.errors.push(msg),
    clearErrors: () => {},
    render: () => { calls.renders++; },
    console: { warn() {}, log() {} },
    setInterval: () => 0,
    setTimeout: () => 0,
    AbortSignal: { timeout: () => undefined },
    __calls: calls,
    __setNow: (ms) => { now = ms; },
  };
  vm.createContext(ctx);
  vm.runInContext(script, ctx, { filename: 'extracted-pending-settle.js' });
  return ctx;
}

function placeEntry(ctx, ts, status) {
  const entry = { roundId: 'r1', track: '1d', guess: 42, ts: ts, status: status || 'pending' };
  ctx.pendingGuesses.push(entry);
  return entry;
}

check('PENDING_SETTLE_MS is the 60s backstop between the send budget and the 90s TTL', () => {
  assert.strictEqual(vm.runInContext('PENDING_SETTLE_MS', makeSandbox()), 60000);
});

check('pending past 60s: flips to timeout, one DELETE, one hint, render', () => {
  const ctx = makeSandbox();
  const entry = placeEntry(ctx, BASE_T);
  ctx.__setNow(BASE_T + 61000);
  ctx.settlePendingGuesses();
  assert.strictEqual(entry.status, 'timeout', 'entry must flip to timeout');
  assert.strictEqual(ctx.__calls.deletes.length, 1, 'exactly one DELETE');
  assert.deepStrictEqual(ctx.__calls.deletes[0], {
    url: '/api/pending-guess',
    body: { round: 'r1', guess: 42 },
  });
  assert.deepStrictEqual(ctx.__calls.errors, [HINT]);
  assert.strictEqual(ctx.__calls.renders, 1, 'settlePendingGuesses re-renders on the flip');
});

check('pending under 60s: no flip, no DELETE, no render', () => {
  const ctx = makeSandbox();
  const entry = placeEntry(ctx, BASE_T);
  ctx.__setNow(BASE_T + 59000);
  ctx.settlePendingGuesses();
  assert.strictEqual(entry.status, 'pending');
  assert.strictEqual(ctx.__calls.deletes.length, 0);
  assert.strictEqual(ctx.__calls.errors.length, 0);
  assert.strictEqual(ctx.__calls.renders, 0);
});

check('timeout past 90s with stale gameState: row dropped and re-rendered (failed-poll path)', () => {
  const ctx = makeSandbox();
  placeEntry(ctx, BASE_T, 'timeout');
  ctx.__setNow(BASE_T + 91000);
  ctx.settlePendingGuesses();
  assert.strictEqual(ctx.pendingGuesses.length, 0, '90s TTL drop must run via the settle pass');
  assert.strictEqual(ctx.__calls.renders, 1);
});

check('timeout under 90s: row kept, still dimmed, no hint from the settle pass', () => {
  const ctx = makeSandbox();
  const entry = placeEntry(ctx, BASE_T, 'timeout');
  ctx.__setNow(BASE_T + 89000);
  ctx.settlePendingGuesses();
  assert.strictEqual(ctx.pendingGuesses.length, 1);
  assert.strictEqual(entry.status, 'timeout');
  assert.strictEqual(ctx.__calls.renders, 0, 'unchanged signature must not rebuild the DOM');
});

check('landed guess: entry dropped without a settle-pass DELETE', () => {
  const ctx = makeSandbox();
  ctx.gameState.tracks['1d'].currentRound.guesses.push({ from: ctx.myAddress, guess: 42 });
  placeEntry(ctx, BASE_T);
  ctx.__setNow(BASE_T + 61000);
  ctx.settlePendingGuesses();
  assert.strictEqual(ctx.pendingGuesses.length, 0, 'landed entry must be dropped');
  assert.strictEqual(ctx.__calls.deletes.length, 0, 'the settle pass must not DELETE a landed guess');
  assert.strictEqual(ctx.__calls.errors.length, 0);
});

check('markGuessConfirmed: issues one DELETE so a reload cannot rehydrate it', () => {
  const ctx = makeSandbox();
  ctx.markGuessConfirmed('r1', 42);
  assert.strictEqual(ctx.pendingGuesses.length, 1);
  assert.strictEqual(ctx.pendingGuesses[0].status, 'confirmed');
  assert.deepStrictEqual(ctx.__calls.deletes, [
    { url: '/api/pending-guess', body: { round: 'r1', guess: 42 } },
  ]);
});

check('markGuessConfirmed in DEMO: no DELETE, row still confirms', () => {
  const ctx = makeSandbox({ demo: true });
  ctx.markGuessConfirmed('r1', 42);
  assert.strictEqual(ctx.pendingGuesses[0].status, 'confirmed');
  assert.strictEqual(ctx.__calls.deletes.length, 0, 'DEMO must never hit /api/pending-guess');
});

check('DEMO pending past 60s: no flip (demo rows are reconciled by the demo flow only)', () => {
  const ctx = makeSandbox({ demo: true });
  const entry = placeEntry(ctx, BASE_T);
  ctx.__setNow(BASE_T + 120000);
  ctx.settlePendingGuesses();
  assert.strictEqual(entry.status, 'pending', 'the settle backstop must not fire in DEMO');
  assert.strictEqual(ctx.__calls.deletes.length, 0);
  assert.strictEqual(ctx.__calls.errors.length, 0);
});

check('a landed guess past 60s never shows the hint', () => {
  const ctx = makeSandbox();
  placeEntry(ctx, BASE_T, 'timeout');
  ctx.__setNow(BASE_T + 61000);
  ctx.reconcilePendingGuesses();
  assert.strictEqual(ctx.__calls.errors.length, 0);
});

check('the shipped page wires the settle interval next to the countdown timer', () => {
  assert.ok(html.includes('settleTimer = setInterval(settlePendingGuesses, GUESS_RECONCILE_INTERVAL_MS)'),
    'init() must start the settle pass');
  assert.ok(html.includes('settlePendingGuesses();'),
    'refreshState() catch branch must call the settle pass');
});

process.exit(failures ? 1 : 0);
