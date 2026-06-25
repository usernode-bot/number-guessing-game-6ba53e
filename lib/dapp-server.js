/**
 * Shared server utilities for Usernode dapps.
 * Vendored from usernode-dapp-starter/examples/lib/dapp-server.js
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { txMatches } = require('./tx-match');

const DEFAULT_USERNAMES_PUBKEY =
  process.env.USERNAMES_PUBKEY ||
  'ut1p0p7y8ujacndc60r4a7pzk45dufdtarp6satvc0md7866633u8sqagm3az';

const RECENT_WAITERS_LIMIT = 50;

// ---------------------------------------------------------------------------
// .env loader
// ---------------------------------------------------------------------------

function loadEnvFile(filePath) {
  filePath = filePath || path.join(process.cwd(), '.env');
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  }
}

// ---------------------------------------------------------------------------
// Explorer upstream helpers
// ---------------------------------------------------------------------------

const EXPLORER_UPSTREAM =
  process.env.EXPLORER_UPSTREAM || 'testnet-explorer.usernodelabs.org';
const EXPLORER_UPSTREAM_BASE =
  process.env.EXPLORER_UPSTREAM_BASE != null
    ? process.env.EXPLORER_UPSTREAM_BASE
    : '/api';
const EXPLORER_PROXY_PREFIX = '/explorer-api/';

const _explorerHostHealth = {};

function getExplorerUpstreams() {
  return EXPLORER_UPSTREAM.split(',').map((h) => h.trim()).filter(Boolean);
}

function pickActiveExplorerUpstream() {
  const hosts = getExplorerUpstreams();
  if (hosts.length === 1) return hosts[0];
  const healthy = hosts.filter((h) => _explorerHostHealth[h] !== false);
  return healthy.length ? healthy[0] : hosts[0];
}

function handleExplorerProxy(req, res, pathname, opts) {
  opts = opts || {};
  const upstream = opts.upstream || pickActiveExplorerUpstream();
  const upstreamBase = opts.upstreamBase != null ? opts.upstreamBase : EXPLORER_UPSTREAM_BASE;
  const suffix = pathname.startsWith(EXPLORER_PROXY_PREFIX)
    ? pathname.slice(EXPLORER_PROXY_PREFIX.length)
    : pathname;
  const upstreamPath = upstreamBase + '/' + suffix;
  const isHttps = upstream.startsWith('http://') ? false : true;
  // Split an optional explicit port (`host:1234`) so http.request gets a clean
  // hostname — otherwise a `host` with an embedded port fails DNS resolution.
  const hostPort = upstream.replace(/^https?:\/\//, '');
  const colon = hostPort.lastIndexOf(':');
  const host = colon > 0 ? hostPort.slice(0, colon) : hostPort;
  const port = colon > 0 ? parseInt(hostPort.slice(colon + 1), 10) : undefined;

  // Hard upper bound on a single upstream round-trip. Without this the request
  // (which the wallet bridge polls after every send to confirm inclusion) could
  // hang indefinitely on a stalled or black-holed explorer host — the user then
  // sees the action spin forever and never receive a result. On timeout we fail
  // the host over and return promptly so the client falls back to chain-state
  // reconciliation instead of waiting on a dead socket.
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 12000;

  let body = '';
  let settled = false;
  const finish = (fn) => { if (settled) return; settled = true; fn(); };

  const clientReq = (isHttps ? https : http).request(
    { host, port, path: upstreamPath + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''), method: req.method, headers: { accept: 'application/json', 'user-agent': 'usernode-dapp-proxy/1' } },
    (proxyRes) => {
      _explorerHostHealth[upstream] = proxyRes.statusCode < 500;
      res.set('access-control-allow-origin', '*');
      res.set('cache-control', 'no-store');
      res.status(proxyRes.statusCode);
      proxyRes.on('data', (chunk) => { body += chunk; });
      proxyRes.on('end', () => finish(() => res.send(body)));
      proxyRes.on('error', () => finish(() => { if (!res.headersSent) res.status(502).json({ error: 'explorer stream error' }); else res.end(); }));
    }
  );
  clientReq.setTimeout(timeoutMs, () => {
    _explorerHostHealth[upstream] = false;
    clientReq.destroy(new Error('explorer upstream timeout after ' + timeoutMs + 'ms'));
  });
  clientReq.on('error', (e) => {
    _explorerHostHealth[upstream] = false;
    finish(() => {
      // If we already started streaming a response we can't change the status —
      // just end it so the client stops waiting rather than hanging on the socket.
      if (!res.headersSent) res.status(504).json({ error: 'explorer unavailable', detail: e.message });
      else res.end();
    });
  });
  if (req.body && req.method !== 'GET') {
    clientReq.write(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
  }
  clientReq.end();
}

// ---------------------------------------------------------------------------
// Chain info discovery
// ---------------------------------------------------------------------------

async function discoverChainInfo(opts) {
  opts = opts || {};
  const nodeRpcUrl = opts.nodeRpcUrl || process.env.NODE_RPC_URL || 'http://usernode-node:3000';

  try {
    const res = await fetch(`${nodeRpcUrl}/status`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      const chainId = data.chain_id || data.chainId || data.network || 'ut-mainnet-1';
      return { chainId, genesisTimestampMs: data.genesis_timestamp_ms || 0 };
    }
  } catch {}

  try {
    const explorerHost = pickActiveExplorerUpstream();
    const base = explorerHost.startsWith('http') ? explorerHost : `https://${explorerHost}`;
    const res = await fetch(`${base}${EXPLORER_UPSTREAM_BASE}/active_chain`, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = await res.json();
      const chainId = data.id || data.chain_id || data.chainId || 'ut-mainnet-1';
      return { chainId, genesisTimestampMs: data.genesis_timestamp_ms || 0 };
    }
  } catch {}

  return { chainId: 'ut-mainnet-1', genesisTimestampMs: 0 };
}

// ---------------------------------------------------------------------------
// Paginated historical fetch
// ---------------------------------------------------------------------------

async function fetchAllTransactions(opts) {
  opts = opts || {};
  const nodeRpcUrl = opts.nodeRpcUrl || process.env.NODE_RPC_URL || 'http://usernode-node:3000';
  const chainId = opts.chainId || 'ut-mainnet-1';
  const queryField = opts.queryField || 'recipient';
  const pubkey = opts.pubkey;

  const explorerHost = pickActiveExplorerUpstream();
  const explorerBase = explorerHost.startsWith('http') ? explorerHost : `https://${explorerHost}`;
  const allTxs = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const url = `${explorerBase}${EXPLORER_UPSTREAM_BASE}/${chainId}/transactions?${queryField}=${encodeURIComponent(pubkey)}&page=${page}&per_page=${perPage}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) break;
      const data = await res.json();
      const txs = data.transactions || data.data || data || [];
      if (!Array.isArray(txs) || txs.length === 0) break;
      allTxs.push(...txs);
      if (txs.length < perPage) break;
      page++;
    } catch (e) {
      console.error('fetchAllTransactions error:', e.message);
      break;
    }
  }
  return allTxs;
}

// ---------------------------------------------------------------------------
// Chain poller (fallback when no SSE stream)
// ---------------------------------------------------------------------------

function createChainPoller(opts) {
  opts = opts || {};
  const queryField = opts.queryField || 'recipient';
  const pubkey = opts.pubkey;
  const nodeRpcUrl = opts.nodeRpcUrl;
  const onTx = opts.onTx || function () {};
  const intervalMs = opts.intervalMs || 4000;
  let chainId = opts.chainId || 'ut-mainnet-1';
  let seenIds = new Set(opts.seenIds || []);
  let timer = null;
  let lastTs = opts.lastTs || 0;
  let ready = false;

  async function poll() {
    const explorerHost = pickActiveExplorerUpstream();
    const explorerBase = explorerHost.startsWith('http') ? explorerHost : `https://${explorerHost}`;
    try {
      const url = `${explorerBase}${EXPLORER_UPSTREAM_BASE}/${chainId}/transactions?${queryField}=${encodeURIComponent(pubkey)}&page=1&per_page=50&order=desc`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return;
      const data = await res.json();
      const txs = (data.transactions || data.data || []).reverse();
      for (const tx of txs) {
        const id = tx.id || tx.txid || tx.txId || tx.hash;
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);
        onTx(tx);
      }
      ready = true;
    } catch {}
  }

  return {
    start() { poll(); timer = setInterval(poll, intervalMs); },
    stop() { if (timer) clearInterval(timer); timer = null; },
    isReady() { return ready; },
  };
}

// ---------------------------------------------------------------------------
// Node SSE stream (direct from node)
// ---------------------------------------------------------------------------

function createNodeRecentTxStream(opts) {
  opts = opts || {};
  const nodeRpcUrl = opts.nodeRpcUrl || 'http://usernode-node:3000';
  const queryField = opts.queryField || 'recipient';
  const pubkey = opts.pubkey;
  const onTx = opts.onTx || function () {};
  const seenIds = new Set(opts.seenIds || []);
  let ready = false;
  let abortCtrl = null;

  function startPolling() {
    const poller = createChainPoller({ queryField, pubkey, nodeRpcUrl, onTx, seenIds, intervalMs: 4000 });
    poller.start();
    ready = true;
    return poller;
  }

  let poller = null;

  async function connect() {
    const streamUrl = `${nodeRpcUrl}/stream/recent_transactions?${queryField}=${encodeURIComponent(pubkey)}`;
    abortCtrl = new AbortController();
    try {
      const res = await fetch(streamUrl, { signal: abortCtrl.signal, headers: { accept: 'text/event-stream' } });
      if (!res.ok || !res.body) throw new Error('no stream');
      ready = true;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const part of parts) {
          for (const line of part.split('\n')) {
            if (!line.startsWith('data:')) continue;
            try {
              const tx = JSON.parse(line.slice(5).trim());
              const id = tx.id || tx.txid || tx.txId || tx.hash;
              if (id && !seenIds.has(id)) { seenIds.add(id); onTx(tx); }
            } catch {}
          }
        }
      }
    } catch {}
    // fallback to polling
    if (!poller) poller = startPolling();
  }

  return {
    start() { connect(); },
    isReady() { return ready; },
  };
}

// ---------------------------------------------------------------------------
// App state cache
// ---------------------------------------------------------------------------

function createAppStateCache(opts) {
  opts = opts || {};
  const name = opts.name || 'app';
  const appPubkey = opts.appPubkey;
  const processTransaction = opts.processTransaction;
  const queryField = opts.queryField || opts.queryFields || 'recipient';
  const queryFields = Array.isArray(queryField) ? queryField : [queryField];
  const nodeRpcUrl = opts.nodeRpcUrl || process.env.NODE_RPC_URL || 'http://usernode-node:3000';
  const resetCallback = opts.resetCallback || null;
  const useNodeStream = opts.useNodeStream !== false && !!nodeRpcUrl;

  const rawTxs = [];
  const rawTxIds = new Set();
  let chainId = 'ut-mainnet-1';
  let streamReady = false;

  const waiters = [];

  function ingestTx(tx) {
    const id = tx.id || tx.txid || tx.txId || tx.hash || tx.transaction_id;
    if (!id) return;
    if (rawTxIds.has(id)) return;
    rawTxIds.add(id);
    rawTxs.push(tx);
    if (processTransaction) {
      try { processTransaction(tx); } catch (e) { console.error(`[${name}] processTransaction error:`, e.message); }
    }
    // notify waiters
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if (txMatches(tx, w.expected)) {
        w.resolve(tx);
        waiters.splice(i, 1);
      }
    }
  }

  async function start() {
    try {
      const info = await discoverChainInfo({ nodeRpcUrl });
      chainId = info.chainId;
    } catch {}

    // Historical backfill
    for (const field of queryFields) {
      const txs = await fetchAllTransactions({
        nodeRpcUrl, chainId, queryField: field, pubkey: appPubkey,
      });
      // Sort by timestamp ascending for consistent ordering
      txs.sort((a, b) => {
        const ta = a.timestamp_ms || (a.created_at ? new Date(a.created_at).getTime() : 0);
        const tb = b.timestamp_ms || (b.created_at ? new Date(b.created_at).getTime() : 0);
        return ta - tb;
      });
      for (const tx of txs) ingestTx(tx);
    }

    // Live updates
    for (const field of queryFields) {
      if (useNodeStream && field === 'recipient') {
        const stream = createNodeRecentTxStream({
          nodeRpcUrl, queryField: field, pubkey: appPubkey,
          onTx: ingestTx, seenIds: rawTxIds,
        });
        stream.start();
        setTimeout(() => { streamReady = true; }, 1000);
      } else {
        const poller = createChainPoller({
          nodeRpcUrl, queryField: field, pubkey: appPubkey,
          chainId, onTx: ingestTx, seenIds: rawTxIds, intervalMs: 4000,
        });
        poller.start();
        setTimeout(() => { streamReady = true; }, 2000);
      }
    }
  }

  function isStreamReady() { return streamReady; }

  // Feed seed transactions directly into the cache (staging only). Each tx is
  // run through the same ingest path as real chain txs, so processTransaction
  // fires and id-dedup (rawTxIds) keeps it idempotent against later backfill.
  function injectSeedTransactions(txs) {
    if (!Array.isArray(txs)) return;
    for (const tx of txs) ingestTx(tx);
  }

  function getRawTransactions() { return rawTxs.slice(); }

  function getStats() {
    return { name, appPubkey, txCount: rawTxs.length, streamReady };
  }

  const cachePrefix = `/__usernode/cache/${appPubkey}`;

  function handleRequest(req, res, pathname) {
    if (!pathname.startsWith(cachePrefix)) return false;
    const sub = pathname.slice(cachePrefix.length);

    if (sub === '/getTransactions' || sub === '/getTransactions/') {
      // Apply filters from query params (bridge sends these)
      const q = req.query || {};
      let txs = rawTxs;
      if (q.recipient) txs = txs.filter((t) => (t.to || t.destination_pubkey) === q.recipient);
      if (q.sender) txs = txs.filter((t) => (t.from || t.from_pubkey) === q.sender);
      res.set('cache-control', 'no-store');
      res.set('access-control-allow-origin', '*');
      res.json({ transactions: txs });
      return true;
    }

    if (sub === '/waitForTx' || sub === '/waitForTx/') {
      const q = req.query || {};
      const expected = {};
      if (q.txId) expected.txId = q.txId;
      if (q.minCreatedAtMs) expected.minCreatedAtMs = parseInt(q.minCreatedAtMs, 10);
      if (q.memo) expected.memo = q.memo;
      if (q.destination_pubkey) expected.destination_pubkey = q.destination_pubkey;
      if (q.from_pubkey) expected.from_pubkey = q.from_pubkey;

      // Check if already in cache
      const found = rawTxs.find((tx) => txMatches(tx, expected));
      if (found) {
        res.set('cache-control', 'no-store');
        res.json({ found: true, tx: found });
        return true;
      }

      // SSE
      res.set('content-type', 'text/event-stream');
      res.set('cache-control', 'no-store');
      res.set('access-control-allow-origin', '*');
      res.set('x-accel-buffering', 'no');
      res.flushHeaders();
      res.write('data: {"waiting":true}\n\n');

      const timeoutMs = parseInt(q.timeoutMs || '180000', 10);
      let resolved = false;

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          res.write('data: {"timeout":true}\n\n');
          res.end();
        }
      }, timeoutMs);

      const waiter = {
        expected,
        resolve(tx) {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          res.write(`data: ${JSON.stringify({ found: true, tx })}\n\n`);
          res.end();
        },
      };
      if (waiters.length < RECENT_WAITERS_LIMIT) waiters.push(waiter);
      req.on('close', () => {
        resolved = true;
        clearTimeout(timer);
        const idx = waiters.indexOf(waiter);
        if (idx >= 0) waiters.splice(idx, 1);
      });
      return true;
    }

    return false;
  }

  return { start, handleRequest, isStreamReady, injectSeedTransactions, getRawTransactions, getStats, appPubkey, name };
}

// ---------------------------------------------------------------------------
// Usernames cache
// ---------------------------------------------------------------------------

function createUsernamesCache(opts) {
  opts = opts || {};
  const nodeRpcUrl = opts.nodeRpcUrl || process.env.NODE_RPC_URL || 'http://usernode-node:3000';

  const usernamesMap = new Map();

  function processTransaction(rawTx) {
    const from = rawTx.from_pubkey || rawTx.from || rawTx.source;
    if (!from) return;
    let memo = rawTx.memo;
    if (typeof memo === 'string') {
      try { memo = JSON.parse(memo); } catch { return; }
    }
    if (!memo || memo.app !== 'usernames' || memo.type !== 'set_username') return;
    const username = memo.username;
    if (!username || typeof username !== 'string') return;
    const ts = rawTx.timestamp_ms || (rawTx.created_at ? new Date(rawTx.created_at).getTime() : 0);
    const existing = usernamesMap.get(from);
    if (!existing || ts > existing.ts) {
      usernamesMap.set(from, { name: username, ts });
    }
  }

  const cache = createAppStateCache({
    name: 'usernames',
    appPubkey: DEFAULT_USERNAMES_PUBKEY,
    queryField: 'recipient',
    processTransaction,
    nodeRpcUrl,
  });

  function getStateResponse() {
    const usernames = {};
    usernamesMap.forEach((v, k) => { usernames[k] = v.name; });
    return { usernames };
  }

  function handleRequest(req, res, pathname) {
    if (pathname === '/__usernames/state' || pathname === '/__usernames/state/') {
      res.set('cache-control', 'no-store');
      res.json(getStateResponse());
      return true;
    }
    return cache.handleRequest(req, res, pathname);
  }

  return {
    start: cache.start.bind(cache),
    handleRequest,
    isStreamReady: cache.isStreamReady.bind(cache),
    injectSeedTransactions: cache.injectSeedTransactions.bind(cache),
    getStateResponse,
    usernamesPubkey: DEFAULT_USERNAMES_PUBKEY,
    appPubkey: DEFAULT_USERNAMES_PUBKEY,
    getStats: cache.getStats.bind(cache),
  };
}

// ---------------------------------------------------------------------------
// Node status probe
// ---------------------------------------------------------------------------

function createNodeStatusProbe(opts) {
  opts = opts || {};
  const nodeRpcUrl = opts.nodeRpcUrl || process.env.NODE_RPC_URL || 'http://usernode-node:3000';
  const intervalMs = opts.intervalMs || 2000;
  const bootIntervalMs = opts.bootIntervalMs || 500;

  const streams = {};
  let snapshot = null;
  let timer = null;
  let synced = false;
  let explorerHasBeenOk = false;
  const updateListeners = [];

  async function tickNode() {
    try {
      const res = await fetch(`${nodeRpcUrl}/status`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return { status: 'unreachable' };
      const data = await res.json();
      const status = data.node_sync_status || data.status || data.sync_status || 'unknown';
      return {
        status,
        peerCount: data.peer_count || data.peers || 0,
        bestTipHeight: data.best_tip_height || data.tip_height || 0,
        peerBestTipHeight: data.peer_best_tip_height || data.peer_tip || 0,
        hasFullUtxoDb: data.HAS_FULL_UTXO_DB || data.has_full_utxo_db || false,
      };
    } catch {
      return { status: 'unreachable' };
    }
  }

  async function tickExplorer() {
    const hosts = getExplorerUpstreams();
    const results = await Promise.allSettled(
      hosts.map(async (host) => {
        const base = host.startsWith('http') ? host : `https://${host}`;
        const res = await fetch(`${base}${EXPLORER_UPSTREAM_BASE}/active_chain`, { signal: AbortSignal.timeout(5000) });
        _explorerHostHealth[host] = res.ok;
        return res.ok ? 'ok' : 'bad_response';
      })
    );
    const statuses = results.map((r) => r.status === 'fulfilled' ? r.value : 'unreachable');
    const anyOk = statuses.some((s) => s === 'ok');
    if (anyOk) explorerHasBeenOk = true;
    const overall = anyOk ? 'ok' : statuses.some((s) => s === 'bad_response') ? 'bad_response' : 'unreachable';
    return { status: overall, hosts: statuses };
  }

  async function tick() {
    const [nodeResult, explorerResult] = await Promise.allSettled([tickNode(), tickExplorer()]);
    const node = nodeResult.status === 'fulfilled' ? nodeResult.value : { status: 'unreachable' };
    const explorer = explorerResult.status === 'fulfilled' ? explorerResult.value : { status: 'unreachable' };

    const streamSnap = {};
    for (const [k, fn] of Object.entries(streams)) streamSnap[k] = fn();

    const prevSnapshot = snapshot;
    snapshot = {
      status: node.status,
      peerCount: node.peerCount,
      bestTipHeight: node.bestTipHeight,
      peerBestTipHeight: node.peerBestTipHeight,
      explorer: explorer.status,
      explorerHasBeenOk,
      explorerDown: explorer.status !== 'ok' && explorer.status !== 'degraded',
      streams: streamSnap,
      hasBeenSynced: synced || node.status === 'Synced',
    };
    if (node.status === 'Synced') synced = true;

    for (const fn of updateListeners) {
      try { fn(snapshot, prevSnapshot); } catch {}
    }

    // Adapt interval
    if (node.status === 'Synced' && timer) {
      clearInterval(timer);
      timer = setInterval(tick, intervalMs);
    }
  }

  function start() {
    tick();
    timer = setInterval(tick, bootIntervalMs);
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function get() { return snapshot; }

  function registerStream(name, isReadyFn) {
    streams[name] = isReadyFn;
  }

  function onUpdate(fn) { updateListeners.push(fn); }

  function handleRequest(req, res, pathname) {
    if (pathname === '/__usernode/node_status' || pathname === '/__usernode/node_status/') {
      res.set('cache-control', 'no-store');
      res.set('access-control-allow-origin', '*');
      res.json(snapshot || { status: 'unreachable', streams: {} });
      return true;
    }
    return false;
  }

  return { start, stop, get, handleRequest, registerStream, onUpdate };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  loadEnvFile,
  getExplorerUpstreams,
  handleExplorerProxy,
  fetchAllTransactions,
  discoverChainInfo,
  createChainPoller,
  createNodeRecentTxStream,
  createAppStateCache,
  createUsernamesCache,
  createNodeStatusProbe,
  EXPLORER_PROXY_PREFIX,
  DEFAULT_USERNAMES_PUBKEY,
};
