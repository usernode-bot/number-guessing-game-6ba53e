/**
 * Canonical txMatches predicate.
 * Used in two places that MUST agree: the SSE waitForTx route and the
 * usernode-bridge polling fallback. Pure function, no side effects, no I/O.
 */

function pickFirst(obj, keys) {
  for (var i = 0; i < keys.length; i++) {
    if (obj[keys[i]] != null) return obj[keys[i]];
  }
  return null;
}

// Order-insensitive deep equality for the small JSON objects we put in memos.
// Lets a re-serialized memo (different key order / whitespace) from the node
// still match the exact string the bridge sent.
function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== 'object' || typeof b !== 'object') return a === b;
  var aArr = Array.isArray(a), bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  var ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (var j = 0; j < ak.length; j++) {
    var k = ak[j];
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

function tryParseJson(s) {
  if (typeof s !== 'string') return undefined;
  var t = s.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return undefined;
  try { return JSON.parse(t); } catch (e) { return undefined; }
}

// Memo equality that tolerates benign re-serialization. Compares as parsed JSON
// when both sides are JSON; otherwise falls back to a raw string compare.
function memoMatches(txMemo, expectedMemo) {
  var a = txMemo == null ? null : String(txMemo);
  var b = String(expectedMemo);
  if (a === b) return true;
  if (a == null) return false;
  var pa = tryParseJson(a), pb = tryParseJson(b);
  if (pa !== undefined && pb !== undefined) return deepEqual(pa, pb);
  return false;
}

function extractTxTimestampMs(tx) {
  if (!tx || typeof tx !== 'object') return null;
  var candidates = [
    tx.timestamp_ms, tx.created_at, tx.createdAt,
    tx.timestamp, tx.time, tx.seen_at, tx.seenAt,
  ];
  for (var i = 0; i < candidates.length; i++) {
    var v = candidates[i];
    if (typeof v === 'number' && Number.isFinite(v)) {
      return v < 10000000000 ? v * 1000 : v;
    }
    if (typeof v === 'string' && v.trim()) {
      var t = Date.parse(v);
      if (!Number.isNaN(t)) return t;
    }
  }
  return null;
}

function txMatches(tx, expected) {
  if (!tx || typeof tx !== 'object') return false;
  if (!expected || typeof expected !== 'object') return false;

  if (expected.txId) {
    var ids = [tx.id, tx.txid, tx.txId, tx.tx_id, tx.hash, tx.tx_hash, tx.txHash]
      .filter(function (v) { return typeof v === 'string'; })
      .map(function (v) { return v.trim(); })
      .filter(Boolean);
    if (ids.indexOf(expected.txId) >= 0) return true;
  }

  if (typeof expected.minCreatedAtMs === 'number') {
    var txTime = extractTxTimestampMs(tx);
    if (typeof txTime === 'number' && txTime < expected.minCreatedAtMs - 5000) {
      return false;
    }
  }

  if (expected.memo != null) {
    if (!memoMatches(tx.memo, expected.memo)) return false;
  }

  if (expected.destination_pubkey != null) {
    var dest = pickFirst(tx, ['destination_pubkey', 'destination', 'to']);
    if ((dest == null ? null : String(dest)) !== expected.destination_pubkey) return false;
  }

  // `from_pubkey` is matched leniently: when the tx carries a sender field we
  // require it to match, but a tx that omits the field (field-naming divergence
  // between node/explorer payloads, or the wallet/JWT pubkey mismatch flagged by
  // the my-history diagnostic) is NOT rejected on that basis. The strong signals
  // — destination + memo + recency — already pin the transaction, and the cache
  // is scoped to recipient = APP_PUBKEY, so this only widens matches that would
  // otherwise be false misses.
  if (expected.from_pubkey != null) {
    var from = pickFirst(tx, ['from_pubkey', 'source', 'from']);
    if (from != null && String(from) !== expected.from_pubkey) return false;
  }

  return true;
}

module.exports = { txMatches, extractTxTimestampMs, pickFirst, memoMatches, deepEqual };
