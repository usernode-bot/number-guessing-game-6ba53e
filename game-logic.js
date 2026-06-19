'use strict';

/**
 * Number Guessing Game logic.
 *
 * All state is reconstructed from on-chain memo transactions.
 * processTransaction is called for every tx where recipient === APP_PUBKEY.
 */

function createGame(opts) {
  opts = opts || {};
  const appPubkey = opts.appPubkey;
  const timerDurationMs = opts.timerDurationMs || 86400000;
  const minPlayers = opts.minPlayers || 2;

  // rounds keyed by round_id
  const rounds = new Map();
  // Set of processed tx IDs (dedup)
  const seenTxIds = new Set();

  function normalizeTx(rawTx) {
    const id = rawTx.id || rawTx.txid || rawTx.txId || rawTx.tx_id || rawTx.hash;
    const from = rawTx.from_pubkey || rawTx.from || rawTx.source || '';
    const to = rawTx.to || rawTx.destination_pubkey || rawTx.destination || '';
    const amount = typeof rawTx.amount === 'number' ? rawTx.amount :
      (parseInt(rawTx.amount, 10) || 0);
    let memo = rawTx.memo;
    if (typeof memo === 'string') {
      try { memo = JSON.parse(memo); } catch { memo = null; }
    }
    const ts = rawTx.timestamp_ms ||
      (rawTx.created_at ? new Date(rawTx.created_at).getTime() : 0);
    return { id, from, to, amount, memo, ts };
  }

  function processTransaction(rawTx) {
    const tx = normalizeTx(rawTx);
    if (!tx.id) return;
    if (seenTxIds.has(tx.id)) return;
    seenTxIds.add(tx.id);

    const memo = tx.memo;
    if (!memo || memo.app !== 'numguess') return;

    switch (memo.type) {
      case 'start_round':
        handleStartRound(memo, tx);
        break;
      case 'guess':
        handleGuess(memo, tx);
        break;
      case 'end_round':
        handleEndRound(memo, tx);
        break;
      case 'payout':
        // recorded for audit; state is driven by end_round
        break;
    }
  }

  function handleStartRound(memo, tx) {
    const id = memo.round;
    if (id == null) return;
    const existing = rounds.get(id);
    if (existing && !existing.endedAt) {
      // Extension: update endsAt for same round
      const dur = memo.active_duration_ms || timerDurationMs;
      existing.endsAt = tx.ts + dur;
      existing.activeDurationMs = dur;
      return;
    }
    if (existing) return; // already ended, ignore duplicate
    rounds.set(id, {
      id,
      seedHash: memo.seed_hash,
      activeDurationMs: memo.active_duration_ms || timerDurationMs,
      minPlayers: memo.min_players || minPlayers,
      startedAt: tx.ts,
      endsAt: tx.ts + (memo.active_duration_ms || timerDurationMs),
      guesses: [],
      endedAt: null,
      secret: null,
      winner: null,
      winnerGuess: null,
      pot: null,
      participants: null,
    });
  }

  function handleGuess(memo, tx) {
    const id = memo.round;
    const round = rounds.get(id);
    if (!round) return; // no matching open round
    if (round.endedAt) return; // round already ended
    const guess = parseInt(memo.guess, 10);
    if (!Number.isFinite(guess) || guess < 1 || guess > 100) return;
    // One guess per player per round — oldest wins
    const alreadyGuessed = round.guesses.some((g) => g.from === tx.from);
    if (alreadyGuessed) return;
    round.guesses.push({ from: tx.from, amount: tx.amount, guess, ts: tx.ts });
  }

  function handleEndRound(memo, tx) {
    const id = memo.round;
    const round = rounds.get(id);
    if (!round) return;
    if (round.endedAt) return; // idempotent
    round.endedAt = tx.ts;
    round.secret = memo.secret;
    round.winner = memo.winner;
    round.winnerGuess = memo.winner_guess;
    round.pot = memo.pot;
    round.participants = memo.participants;
  }

  function computeSecret(seedHash) {
    return (parseInt(seedHash.slice(0, 8), 16) % 100) + 1;
  }

  function findWinner(round) {
    if (!round.guesses.length) return null;
    const secret = computeSecret(round.seedHash);
    // Dedup by player — keep earliest guess per player
    const byPlayer = new Map();
    for (const g of round.guesses) {
      const existing = byPlayer.get(g.from);
      if (!existing || g.ts < existing.ts) byPlayer.set(g.from, g);
    }
    const candidates = Array.from(byPlayer.values());
    candidates.sort((a, b) => {
      const distA = Math.abs(a.guess - secret);
      const distB = Math.abs(b.guess - secret);
      if (distA !== distB) return distA - distB;
      return a.ts - b.ts; // tie: earliest wins
    });
    return { winner: candidates[0], secret, candidates };
  }

  function getCurrentRound() {
    let latest = null;
    for (const [, r] of rounds) {
      if (!r.endedAt) {
        if (!latest || r.startedAt > latest.startedAt) latest = r;
      }
    }
    return latest;
  }

  function getPastRounds() {
    const past = [];
    for (const [, r] of rounds) {
      if (r.endedAt) past.push(r);
    }
    past.sort((a, b) => b.startedAt - a.startedAt);
    return past;
  }

  function getPlayerStats() {
    const stats = {};
    for (const [, r] of rounds) {
      if (!r.endedAt || !r.winner) continue;
      const secret = r.secret != null ? r.secret : (r.seedHash ? computeSecret(r.seedHash) : null);
      // winner stats
      const w = r.winner;
      if (!stats[w]) stats[w] = { won: 0, tokensWon: 0, bestDist: Infinity };
      stats[w].won++;
      stats[w].tokensWon += r.pot || 0;
      if (secret != null && r.winnerGuess != null) {
        stats[w].bestDist = Math.min(stats[w].bestDist, Math.abs(r.winnerGuess - secret));
      }
      // all guessers
      for (const g of r.guesses) {
        if (!stats[g.from]) stats[g.from] = { won: 0, tokensWon: 0, bestDist: Infinity };
        if (secret != null) {
          stats[g.from].bestDist = Math.min(stats[g.from].bestDist, Math.abs(g.guess - secret));
        }
      }
    }
    // normalize bestDist
    for (const k of Object.keys(stats)) {
      if (stats[k].bestDist === Infinity) stats[k].bestDist = null;
    }
    return stats;
  }

  function getStateResponse() {
    const currentRound = getCurrentRound();
    const pastRounds = getPastRounds();
    const playerStats = getPlayerStats();

    let currentRoundData = null;
    if (currentRound) {
      currentRoundData = {
        id: currentRound.id,
        startedAt: currentRound.startedAt,
        endsAt: currentRound.endsAt,
        seedHash: currentRound.seedHash,
        minPlayers: currentRound.minPlayers,
        participants: currentRound.guesses.length,
        pot: currentRound.guesses.reduce((s, g) => s + g.amount, 0),
        guesses: currentRound.guesses.map((g) => ({ from: g.from, guess: g.guess, ts: g.ts })),
        endedAt: null,
      };
    }

    return {
      appPubkey,
      loading: false,
      currentRound: currentRoundData,
      pastRounds: pastRounds.map((r) => ({
        id: r.id,
        startedAt: r.startedAt,
        endsAt: r.endsAt,
        endedAt: r.endedAt,
        secret: r.secret,
        winner: r.winner,
        winnerGuess: r.winnerGuess,
        pot: r.pot,
        participants: r.participants,
        guesses: r.guesses.map((g) => ({ from: g.from, guess: g.guess, ts: g.ts })),
      })),
      playerStats,
    };
  }

  function handleRequest(req, res, pathname) {
    if (pathname === '/__numguess/state' || pathname === '/__numguess/state/') {
      res.set('cache-control', 'no-store');
      res.json(getStateResponse());
      return true;
    }
    return false;
  }

  return {
    processTransaction,
    findWinner,
    computeSecret,
    getCurrentRound,
    getPastRounds,
    getStateResponse,
    handleRequest,
    rounds,
    seenTxIds,
    appPubkey,
  };
}

module.exports = { createGame };
