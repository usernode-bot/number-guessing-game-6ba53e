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
    var memo = tx.memo == null ? null : String(tx.memo);
    if (memo !== expected.memo) return false;
  }

  if (expected.destination_pubkey != null) {
    var dest = pickFirst(tx, ['destination_pubkey', 'destination', 'to']);
    if ((dest == null ? null : String(dest)) !== expected.destination_pubkey) return false;
  }

  if (expected.from_pubkey != null) {
    var from = pickFirst(tx, ['from_pubkey', 'source', 'from']);
    if ((from == null ? null : String(from)) !== expected.from_pubkey) return false;
  }

  return true;
}

module.exports = { txMatches, extractTxTimestampMs, pickFirst };
