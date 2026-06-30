'use strict';

const DIFFICULTIES = {
  easy:   { range: 10,   maxGuesses: 5,  base: 100  },
  medium: { range: 100,  maxGuesses: 10, base: 300  },
  hard:   { range: 1000, maxGuesses: 15, base: 1000 },
};

// Score earned for a won round. Returns 0 for losses.
// Formula: base × max(1, maxGuesses − numGuesses + 1), doubled on a bullseye.
function computeRoundScore(difficulty, numGuesses, won, bestDistance) {
  if (!won) return 0;
  const cfg = DIFFICULTIES[difficulty] || DIFFICULTIES.medium;
  const score = cfg.base * Math.max(1, cfg.maxGuesses - numGuesses + 1);
  return bestDistance === 0 ? score * 2 : score;
}

function createGame(opts) {
  opts = opts || {};
  const appPubkey = opts.appPubkey;
  const timerDurationMs = opts.timerDurationMs || 86400000;
  const minPlayers = opts.minPlayers || 2;

  // Players hidden from all public views. Filtered at this derivation layer so
  // every surface (leaderboard, history winner credit, result cards) inherits
  // the hide from one place. Defaults to a no-op when not supplied.
  const isHidden = typeof opts.isHidden === 'function' ? opts.isHidden : () => false;

  // rounds keyed by round_id
  const rounds = new Map();
  // Set of processed tx IDs (dedup)
  const seenTxIds = new Set();

  function inferTrack(activeDurationMs, mode) {
    if (mode === 'timed') return 'timed';
    if (!activeDurationMs || activeDurationMs <= 3600000) return '1h';
    if (activeDurationMs <= 21600000) return '6h';
    if (activeDurationMs <= 86400000) return '1d';
    return '1w';
  }

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
      // Extension: update endsAt for same round only
      const dur = memo.active_duration_ms || timerDurationMs;
      existing.endsAt = tx.ts + dur;
      existing.activeDurationMs = dur;
      return;
    }
    if (existing) return; // already ended, ignore duplicate
    const activeDurationMs = memo.active_duration_ms || timerDurationMs;
    const mode = memo.mode || 'normal';
    const durationTrack = memo.duration_track || inferTrack(activeDurationMs, mode);
    const difficulty = (memo.difficulty && DIFFICULTIES[memo.difficulty]) ? memo.difficulty : 'medium';
    const range = DIFFICULTIES[difficulty].range;
    rounds.set(id, {
      id,
      seedHash: memo.seed_hash,
      activeDurationMs,
      minPlayers: memo.min_players != null ? memo.min_players : minPlayers,
      maxGuessesPerPlayer: memo.max_guesses_per_player != null ? memo.max_guesses_per_player : 1,
      mode,
      durationTrack,
      difficulty,
      range,
      startedAt: tx.ts,
      endsAt: tx.ts + activeDurationMs,
      guesses: [],
      rawGuessCounts: {},
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
    if (!Number.isFinite(guess) || guess < 1 || guess > (round.range || 100)) return;
    // Multi-guess support: count existing guesses from this player
    const playerGuessCount = round.guesses.filter((g) => g.from === tx.from).length;
    if (playerGuessCount >= round.maxGuessesPerPlayer) return;
    // Carry the on-chain tx id onto the guess so downstream consumers (the
    // ledger ingestion hook, per-user history) can reference the chain receipt.
    round.guesses.push({ from: tx.from, amount: tx.amount, guess, ts: tx.ts, id: tx.id });
    round.rawGuessCounts[tx.from] = (round.rawGuessCounts[tx.from] || 0) + 1;
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

  function computeSecret(seedHash, range) {
    range = range || 100;
    return (parseInt(seedHash.slice(0, 8), 16) % range) + 1;
  }

  function findWinner(round) {
    if (!round.guesses.length) return null;
    const secret = computeSecret(round.seedHash, round.range);
    // Dedup by player — keep best guess (closest to secret), tie-break by earliest
    const byPlayer = new Map();
    for (const g of round.guesses) {
      const existing = byPlayer.get(g.from);
      if (!existing) {
        byPlayer.set(g.from, g);
      } else {
        const existingDist = Math.abs(existing.guess - secret);
        const newDist = Math.abs(g.guess - secret);
        if (newDist < existingDist || (newDist === existingDist && g.ts < existing.ts)) {
          byPlayer.set(g.from, g);
        }
      }
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

  // ---------------------------------------------------------------------------
  // Per-track helpers
  // ---------------------------------------------------------------------------

  function getCurrentRoundForTrack(track) {
    let latest = null;
    for (const [, r] of rounds) {
      if (!r.endedAt && r.durationTrack === track) {
        if (!latest || r.startedAt > latest.startedAt) latest = r;
      }
    }
    return latest;
  }

  function getPastRoundsForTrack(track) {
    const past = [];
    for (const [, r] of rounds) {
      if (r.endedAt && r.durationTrack === track) past.push(r);
    }
    past.sort((a, b) => b.startedAt - a.startedAt);
    return past;
  }

  function getPlayerStatsForTrack(track) {
    const stats = {};
    for (const [, r] of rounds) {
      if (!r.endedAt || !r.winner) continue;
      if (r.durationTrack !== track) continue;
      const secret = r.secret != null ? r.secret : (r.seedHash ? computeSecret(r.seedHash, r.range) : null);
      const w = r.winner;
      if (!isHidden(w)) {
        if (!stats[w]) stats[w] = { won: 0, tokensWon: 0, bestDist: Infinity, bestWinGuessCount: null };
        stats[w].won++;
        stats[w].tokensWon += r.pot || 0;
        if (secret != null && r.winnerGuess != null) {
          stats[w].bestDist = Math.min(stats[w].bestDist, Math.abs(r.winnerGuess - secret));
        }
        const winGuessCount = r.rawGuessCounts ? (r.rawGuessCounts[w] || 1) : 1;
        stats[w].bestWinGuessCount = stats[w].bestWinGuessCount === null
          ? winGuessCount
          : Math.min(stats[w].bestWinGuessCount, winGuessCount);
      }
      for (const g of r.guesses) {
        if (isHidden(g.from)) continue;
        if (!stats[g.from]) stats[g.from] = { won: 0, tokensWon: 0, bestDist: Infinity, bestWinGuessCount: null };
        if (secret != null) {
          stats[g.from].bestDist = Math.min(stats[g.from].bestDist, Math.abs(g.guess - secret));
        }
      }
    }
    for (const k of Object.keys(stats)) {
      if (stats[k].bestDist === Infinity) stats[k].bestDist = null;
    }
    return stats;
  }

  function getPlayerStatsForDifficulty(difficulty) {
    const stats = {};
    for (const [, r] of rounds) {
      if (!r.endedAt || !r.winner) continue;
      if ((r.difficulty || 'medium') !== difficulty) continue;
      const secret = r.secret != null ? r.secret : (r.seedHash ? computeSecret(r.seedHash, r.range) : null);
      const w = r.winner;
      if (!isHidden(w)) {
        if (!stats[w]) stats[w] = { won: 0, tokensWon: 0, bestDist: Infinity, bestWinGuessCount: null, totalScore: 0, bestRoundScore: 0 };
        stats[w].won++;
        stats[w].tokensWon += r.pot || 0;
        const winnerDist = (secret != null && r.winnerGuess != null) ? Math.abs(r.winnerGuess - secret) : null;
        if (winnerDist != null) {
          stats[w].bestDist = Math.min(stats[w].bestDist, winnerDist);
        }
        const winGuessCount = r.rawGuessCounts ? (r.rawGuessCounts[w] || 1) : 1;
        stats[w].bestWinGuessCount = stats[w].bestWinGuessCount === null
          ? winGuessCount
          : Math.min(stats[w].bestWinGuessCount, winGuessCount);
        const roundScore = computeRoundScore(difficulty, winGuessCount, true, winnerDist);
        stats[w].totalScore += roundScore;
        if (roundScore > stats[w].bestRoundScore) stats[w].bestRoundScore = roundScore;
      }
      for (const g of r.guesses) {
        if (isHidden(g.from)) continue;
        if (!stats[g.from]) stats[g.from] = { won: 0, tokensWon: 0, bestDist: Infinity, bestWinGuessCount: null, totalScore: 0, bestRoundScore: 0 };
        if (secret != null) {
          stats[g.from].bestDist = Math.min(stats[g.from].bestDist, Math.abs(g.guess - secret));
        }
      }
    }
    for (const k of Object.keys(stats)) {
      if (stats[k].bestDist === Infinity) stats[k].bestDist = null;
    }
    return stats;
  }

  function getPlayerStatsForTrackAndDifficulty(track, difficulty) {
    if (!track || track === 'all') return getPlayerStatsForDifficulty(difficulty);
    const stats = {};
    for (const [, r] of rounds) {
      if (!r.endedAt || !r.winner) continue;
      if (r.durationTrack !== track) continue;
      if ((r.difficulty || 'medium') !== difficulty) continue;
      const secret = r.secret != null ? r.secret : (r.seedHash ? computeSecret(r.seedHash, r.range) : null);
      const w = r.winner;
      if (!isHidden(w)) {
        if (!stats[w]) stats[w] = { won: 0, tokensWon: 0, bestDist: Infinity, bestWinGuessCount: null };
        stats[w].won++;
        stats[w].tokensWon += r.pot || 0;
        if (secret != null && r.winnerGuess != null) {
          stats[w].bestDist = Math.min(stats[w].bestDist, Math.abs(r.winnerGuess - secret));
        }
        const winGuessCount = r.rawGuessCounts ? (r.rawGuessCounts[w] || 1) : 1;
        stats[w].bestWinGuessCount = stats[w].bestWinGuessCount === null
          ? winGuessCount
          : Math.min(stats[w].bestWinGuessCount, winGuessCount);
      }
      for (const g of r.guesses) {
        if (isHidden(g.from)) continue;
        if (!stats[g.from]) stats[g.from] = { won: 0, tokensWon: 0, bestDist: Infinity, bestWinGuessCount: null };
        if (secret != null) {
          stats[g.from].bestDist = Math.min(stats[g.from].bestDist, Math.abs(g.guess - secret));
        }
      }
    }
    for (const k of Object.keys(stats)) {
      if (stats[k].bestDist === Infinity) stats[k].bestDist = null;
    }
    return stats;
  }

  // ---------------------------------------------------------------------------
  // Win streaks — derived purely from completed on-chain rounds
  // ---------------------------------------------------------------------------
  //
  // Mirrors the win/reset rule that used to live in server.js `updateStreaks`:
  //   - a completed round WITH a winner: winner's current streak += 1; every
  //     other participant (distinct guesser) resets to 0; non-participants are
  //     untouched.
  //   - a completed round with NO winner: streaks are not modified at all.
  //   - bestStreak is the running maximum of currentStreak over time.
  // Rounds are folded in chronological order (endedAt asc, fallback startedAt),
  // matching how getPastRoundsForTrack orders history.

  function getTrackStreaks(track) {
    const completed = [];
    for (const [, r] of rounds) {
      if (r.endedAt && r.durationTrack === track) completed.push(r);
    }
    completed.sort((a, b) => {
      const ea = a.endedAt != null ? a.endedAt : a.startedAt;
      const eb = b.endedAt != null ? b.endedAt : b.startedAt;
      return ea - eb;
    });

    const streaks = {}; // pubkey -> { currentStreak, bestStreak }
    const ensure = (pk) => {
      if (!streaks[pk]) streaks[pk] = { currentStreak: 0, bestStreak: 0 };
      return streaks[pk];
    };

    for (const r of completed) {
      if (!r.winner) continue; // no-winner rounds leave every streak untouched
      // A hidden winner is treated like a no-winner round for streak purposes:
      // they earn no credit and other participants are not reset by them.
      if (isHidden(r.winner)) continue;
      const w = ensure(r.winner);
      w.currentStreak += 1;
      if (w.currentStreak > w.bestStreak) w.bestStreak = w.currentStreak;
      const participants = new Set(r.guesses.map((g) => g.from));
      for (const p of participants) {
        if (p === r.winner || isHidden(p)) continue;
        ensure(p).currentStreak = 0;
      }
    }
    return streaks;
  }

  // Per-track streak object for a single player, shaped exactly like the
  // `myStreaks` payload the frontend consumes (each track defaults to 0/0).
  function getMyStreaks(pubkey) {
    const TRACK_KEYS = ['1h', '6h', '1d', '1w'];
    const out = {};
    for (const track of TRACK_KEYS) {
      const s = pubkey ? getTrackStreaks(track)[pubkey] : null;
      out[track] = s
        ? { currentStreak: s.currentStreak, bestStreak: s.bestStreak }
        : { currentStreak: 0, bestStreak: 0 };
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Legacy helpers (kept for backward compat)
  // ---------------------------------------------------------------------------

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
      const secret = r.secret != null ? r.secret : (r.seedHash ? computeSecret(r.seedHash, r.range) : null);
      const w = r.winner;
      if (!isHidden(w)) {
        if (!stats[w]) stats[w] = { won: 0, tokensWon: 0, bestDist: Infinity };
        stats[w].won++;
        stats[w].tokensWon += r.pot || 0;
        if (secret != null && r.winnerGuess != null) {
          stats[w].bestDist = Math.min(stats[w].bestDist, Math.abs(r.winnerGuess - secret));
        }
      }
      for (const g of r.guesses) {
        if (isHidden(g.from)) continue;
        if (!stats[g.from]) stats[g.from] = { won: 0, tokensWon: 0, bestDist: Infinity };
        if (secret != null) {
          stats[g.from].bestDist = Math.min(stats[g.from].bestDist, Math.abs(g.guess - secret));
        }
      }
    }
    for (const k of Object.keys(stats)) {
      if (stats[k].bestDist === Infinity) stats[k].bestDist = null;
    }
    return stats;
  }

  // ---------------------------------------------------------------------------
  // State response builders
  // ---------------------------------------------------------------------------

  function buildCurrentRoundData(round) {
    // Drop hidden players' guesses so they never surface as participants; the
    // pot/participant count is recomputed from the visible guesses.
    const visibleGuesses = round.guesses.filter((g) => !isHidden(g.from));
    return {
      id: round.id,
      startedAt: round.startedAt,
      endsAt: round.endsAt,
      activeDurationMs: round.activeDurationMs,
      minPlayers: round.minPlayers,
      maxGuessesPerPlayer: round.maxGuessesPerPlayer,
      mode: round.mode,
      durationTrack: round.durationTrack,
      difficulty: round.difficulty || 'medium',
      range: round.range || 100,
      participants: visibleGuesses.length,
      pot: visibleGuesses.reduce((s, g) => s + g.amount, 0),
      guesses: visibleGuesses.map((g) => ({ from: g.from, guess: g.guess, ts: g.ts })),
      endedAt: null,
    };
  }

  function buildPastRoundData(r) {
    // A hidden winner loses their winner credit (the round reads as winnerless),
    // and hidden players' guesses are dropped from the per-round guess list so
    // history and result cards never name them.
    const winnerHidden = isHidden(r.winner);
    return {
      id: r.id,
      startedAt: r.startedAt,
      endsAt: r.endsAt,
      activeDurationMs: r.activeDurationMs,
      endedAt: r.endedAt,
      secret: r.secret,
      winner: winnerHidden ? null : r.winner,
      winnerGuess: winnerHidden ? null : r.winnerGuess,
      pot: r.pot,
      participants: r.participants,
      mode: r.mode,
      durationTrack: r.durationTrack,
      difficulty: r.difficulty || 'medium',
      range: r.range || 100,
      maxGuessesPerPlayer: r.maxGuessesPerPlayer,
      guesses: r.guesses.filter((g) => !isHidden(g.from)).map((g) => ({ from: g.from, guess: g.guess, ts: g.ts })),
    };
  }

  function getStateResponse() {
    const TRACK_KEYS = ['1h', '6h', '1d', '1w'];
    const tracks = {};
    for (const track of TRACK_KEYS) {
      const currentRound = getCurrentRoundForTrack(track);
      const pastRounds = getPastRoundsForTrack(track);
      const playerStats = getPlayerStatsForTrack(track);
      tracks[track] = {
        currentRound: currentRound ? buildCurrentRoundData(currentRound) : null,
        pastRounds: pastRounds.map(buildPastRoundData),
        playerStats,
      };
    }
    const difficulties = {};
    for (const diff of ['easy', 'medium', 'hard']) {
      const byTrack = {};
      for (const track of TRACK_KEYS) {
        const trackStreaks = getTrackStreaks(track);
        const streaks = {};
        for (const [pk, s] of Object.entries(trackStreaks)) {
          if (s.bestStreak > 0) streaks[pk] = { bestStreak: s.bestStreak };
        }
        byTrack[track] = {
          playerStats: getPlayerStatsForTrackAndDifficulty(track, diff),
          streaks,
        };
      }
      difficulties[diff] = { playerStats: getPlayerStatsForDifficulty(diff), byTrack };
    }
    return {
      appPubkey,
      loading: false,
      tracks,
      difficulties,
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
    getCurrentRoundForTrack,
    getPastRounds,
    getPastRoundsForTrack,
    getPlayerStatsForTrack,
    getPlayerStatsForDifficulty,
    getPlayerStatsForTrackAndDifficulty,
    getTrackStreaks,
    getMyStreaks,
    getStateResponse,
    handleRequest,
    rounds,
    seenTxIds,
    appPubkey,
  };
}

module.exports = { createGame, DIFFICULTIES, computeRoundScore };
