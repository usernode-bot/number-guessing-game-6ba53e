'use strict';

// Locks in the /__mock/enabled probe contract that the bridge relies on:
// the HTTP STATUS (not the JSON body) signals mock vs. real transaction mode.
// - mock API active (--local-dev)  -> 200 { enabled: true }
// - mock API absent (staging/prod) -> 404 { enabled: false }
// Regression guard for the "Transaction failed: Mock API not enabled" bug,
// where an always-200 probe made deployed apps route sends through /__mock/*.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

// Requiring server.js must NOT boot the server: start() is guarded by
// `require.main === module`. This test process has no --local-dev flag and no
// DATABASE_URL, so it mirrors a staging/production runtime (mockApi === null).
const { app, mockEnabledPayload } = require('../server');

test('mockEnabledPayload returns 404 when the mock API is absent', () => {
  assert.deepStrictEqual(mockEnabledPayload(null), {
    status: 404,
    body: { enabled: false },
  });
});

test('mockEnabledPayload returns 200 when the mock API is active', () => {
  // Any truthy value stands in for a constructed mock API instance.
  assert.deepStrictEqual(mockEnabledPayload({ transactions: [] }), {
    status: 200,
    body: { enabled: true },
  });
});

test('GET /__mock/enabled returns 404 with {enabled:false} outside local-dev', async () => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const { status, body } = await new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: '/__mock/enabled' }, (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode, body: data }));
        })
        .on('error', reject);
    });

    assert.strictEqual(status, 404, 'probe must be non-2xx so the bridge picks the real path');
    assert.deepStrictEqual(JSON.parse(body), { enabled: false });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
