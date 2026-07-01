'use strict';

// ---------------------------------------------------------------------------
// Postgres persistence for per-user game history.
//
// Live gameplay (rounds, guesses, winners, leaderboard, streaks) remains
// fully on-chain and derived on read — see game-logic.js. This module adds a
// single, durable, identity-keyed projection of each authenticated player's
// FINISHED rounds, so a player can review their own results even after a round
// ages out of the live on-chain view. Rows are keyed to `req.user` (the
// platform identity), not just the wallet pubkey.
//
// The whole module degrades gracefully when DATABASE_URL is unset/unreachable:
// every function becomes a no-op (or returns null) so callers can fall back to
// freshly-derived, unsaved results rather than erroring.
// ---------------------------------------------------------------------------

const { Pool } = require('pg');

let pool = null;
const DATABASE_URL = process.env.DATABASE_URL;
if (DATABASE_URL) {
  pool = new Pool({ connectionString: DATABASE_URL });
  // An idle-client error must never crash the process; just log it.
  pool.on('error', (err) => console.error('[db] idle client error:', err.message));
} else {
  console.warn('[db] DATABASE_URL not set — game history persistence disabled (serving derived results only)');
}

function isEnabled() {
  return !!pool;
}

// Idempotent schema migration, safe to run on every boot.
//
// `game_results` is PUBLIC (the platform default): every column here — who
// played which round, their guesses, wins, pot — is already public on-chain,
// so a stranger seeing every row is not a problem. It is therefore NOT marked
// `staging:private`, and it holds no foreign key to any private table.
async function initSchema() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS game_results (
      id              BIGSERIAL PRIMARY KEY,
      user_id         TEXT NOT NULL,
      username        TEXT,
      usernode_pubkey TEXT,
      round_id        INTEGER NOT NULL,
      track           TEXT,
      difficulty      TEXT,
      num_guesses     INTEGER NOT NULL DEFAULT 0,
      won             BOOLEAN NOT NULL DEFAULT false,
      outcome         TEXT,
      best_guess      INTEGER,
      best_distance   INTEGER,
      secret          INTEGER,
      pot             INTEGER NOT NULL DEFAULT 0,
      score           INTEGER NOT NULL DEFAULT 0,
      ended_at        TIMESTAMPTZ,
      recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, round_id)
    )
  `);
  await pool.query(`ALTER TABLE game_results ADD COLUMN IF NOT EXISTS score INTEGER NOT NULL DEFAULT 0`);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS game_results_user_ended_idx
       ON game_results (user_id, ended_at DESC)`
  );

  // `game_guesses` is the per-guess companion to `game_results`: one row per
  // individual guess a player made in a FINISHED round, keyed to the same
  // platform identity. Also PUBLIC (the platform default) — every column is
  // already public on-chain, exactly like `game_results` — so it is NOT marked
  // `staging:private` and holds no foreign key to any private table. The unique
  // (user_id, round_id, guess_index) constraint makes the lazy write idempotent.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS game_guesses (
      id              BIGSERIAL PRIMARY KEY,
      user_id         TEXT NOT NULL,
      username        TEXT,
      usernode_pubkey TEXT,
      round_id        INTEGER NOT NULL,
      track           TEXT,
      difficulty      TEXT,
      guess_index     INTEGER NOT NULL,
      guess           INTEGER NOT NULL,
      distance        INTEGER,
      amount          INTEGER NOT NULL DEFAULT 0,
      guessed_at      TIMESTAMPTZ,
      recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, round_id, guess_index)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS game_guesses_user_round_idx
       ON game_guesses (user_id, round_id)`
  );

  // Carry the on-chain transaction reference on each per-user guess row so the
  // "My Games" detail can link a guess back to its chain receipt. Additive and
  // idempotent — existing rows keep NULL until the next upsert refreshes them.
  await pool.query(`ALTER TABLE game_guesses ADD COLUMN IF NOT EXISTS tx_id TEXT`);

  // `guess_ledger` is the authoritative, append-only capture of EVERY guess from
  // EVERY player, keyed to its on-chain transaction id. Unlike game_guesses (an
  // identity-keyed, lazy, finished-rounds-only projection written on read), this
  // is written from the server's transaction stream as each guess tx is ingested
  // — for active and finished rounds alike, whether or not the player ever opens
  // their history. `tx_id` (the on-chain reference) is UNIQUE, which both dedupes
  // re-ingested txs and makes the boot-time stream replay a safe, self-healing
  // backfill. `memo` keeps the raw memo JSON so the ledger can be processed and
  // replayed faithfully.
  //
  // PUBLIC (the platform default): every column is already public on-chain
  // (guesses, sender pubkeys, rounds), exactly like game_results / game_guesses —
  // a stranger seeing every row is not a problem — so it is NOT marked
  // `staging:private` and holds no foreign key to any private table.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guess_ledger (
      id            BIGSERIAL PRIMARY KEY,
      tx_id         TEXT NOT NULL UNIQUE,
      from_pubkey   TEXT NOT NULL,
      round_id      INTEGER NOT NULL,
      track         TEXT,
      difficulty    TEXT,
      guess         INTEGER NOT NULL,
      amount        INTEGER NOT NULL DEFAULT 0,
      memo          TEXT,
      tx_timestamp  TIMESTAMPTZ,
      recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS guess_ledger_from_round_idx
       ON guess_ledger (from_pubkey, round_id)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS guess_ledger_round_idx
       ON guess_ledger (round_id)`
  );
  // `pending_guesses` is a short-lived, per-user cache of a player's OPTIMISTIC
  // (not-yet-confirmed) guesses — the in-flight window between tapping "Place
  // Guess" and the tx landing on-chain. It exists solely so a page refresh
  // during that window can rehydrate the dimmed "placing…" row rather than
  // losing it. It is NOT authoritative: confirmed gameplay state still derives
  // from chain (see game-logic.js), and losing every row here at worst reverts
  // to the pre-fix behaviour. Keyed to the platform identity (`user_id`), with a
  // UNIQUE (user_id, round_id, guess) so a re-tap / double-submit upserts rather
  // than duplicating (supporting multi-guess rounds, where a player holds
  // several distinct pending guesses in one round). The GET endpoint prunes rows
  // that have landed on-chain, whose round rolled/ended, or that have aged out.
  //
  // PUBLIC (the platform default): a guess value + round is already public
  // on-chain, exactly like game_results / game_guesses / guess_ledger — a
  // stranger seeing every row is not a problem — so it is NOT marked
  // `staging:private` and holds no foreign key to any private table.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_guesses (
      id              BIGSERIAL PRIMARY KEY,
      user_id         TEXT NOT NULL,
      username        TEXT,
      usernode_pubkey TEXT,
      round_id        INTEGER NOT NULL,
      track           TEXT,
      difficulty      TEXT,
      guess           INTEGER NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      placed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, round_id, guess)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS pending_guesses_user_round_idx
       ON pending_guesses (user_id, round_id)`
  );

  console.log('[db] game_results + game_guesses + guess_ledger + pending_guesses schema ready');
}

// Upsert a batch of derived results for one user. Idempotent: the unique
// (user_id, round_id) constraint means re-running fills in / refreshes a row
// rather than duplicating it. `username` is refreshed on every upsert so the
// latest display name is stored even if the player renamed.
async function upsertResults(user, rows) {
  if (!pool || !user || !user.id || !Array.isArray(rows) || rows.length === 0) return;
  for (const r of rows) {
    await pool.query(
      `INSERT INTO game_results
         (user_id, username, usernode_pubkey, round_id, track, difficulty,
          num_guesses, won, outcome, best_guess, best_distance, secret, pot, score, ended_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
               CASE WHEN $15::double precision IS NULL THEN NULL
                    ELSE to_timestamp($15::double precision / 1000.0) END)
       ON CONFLICT (user_id, round_id) DO UPDATE SET
         username        = EXCLUDED.username,
         usernode_pubkey = EXCLUDED.usernode_pubkey,
         track           = EXCLUDED.track,
         difficulty      = EXCLUDED.difficulty,
         num_guesses     = EXCLUDED.num_guesses,
         won             = EXCLUDED.won,
         outcome         = EXCLUDED.outcome,
         best_guess      = EXCLUDED.best_guess,
         best_distance   = EXCLUDED.best_distance,
         secret          = EXCLUDED.secret,
         pot             = EXCLUDED.pot,
         score           = EXCLUDED.score,
         ended_at        = EXCLUDED.ended_at`,
      [
        user.id,
        user.username || null,
        user.usernode_pubkey || null,
        r.round_id,
        r.track || null,
        r.difficulty || null,
        r.num_guesses || 0,
        !!r.won,
        r.outcome || null,
        r.best_guess != null ? r.best_guess : null,
        r.best_distance != null ? r.best_distance : null,
        r.secret != null ? r.secret : null,
        r.pot || 0,
        r.score || 0,
        r.ended_at != null ? r.ended_at : null,
      ]
    );
  }
}

// Fetch a user's saved results, newest first. Returns null when persistence is
// disabled so the caller can fall back to derived results. `ended_at` is
// returned as epoch-ms (matching the on-chain shape the frontend expects).
async function getResultsForUser(userId) {
  if (!pool || !userId) return null;
  const { rows } = await pool.query(
    `SELECT round_id, track, difficulty, num_guesses, won, outcome,
            best_guess, best_distance, secret, pot, score,
            (EXTRACT(EPOCH FROM ended_at) * 1000)::bigint AS ended_at
       FROM game_results
      WHERE user_id = $1
      ORDER BY ended_at DESC NULLS LAST, round_id DESC`,
    [userId]
  );
  return rows.map((r) => ({
    round_id: r.round_id,
    track: r.track,
    difficulty: r.difficulty,
    num_guesses: r.num_guesses,
    won: r.won,
    outcome: r.outcome,
    best_guess: r.best_guess,
    best_distance: r.best_distance,
    secret: r.secret,
    pot: r.pot,
    score: r.score || 0,
    ended_at: r.ended_at != null ? Number(r.ended_at) : null,
  }));
}

// Upsert a batch of per-guess rows for one user. Idempotent: the unique
// (user_id, round_id, guess_index) constraint refreshes an existing row rather
// than duplicating it. `username` is refreshed on every upsert so renames
// propagate, mirroring `upsertResults`.
async function upsertGuesses(user, rows) {
  if (!pool || !user || !user.id || !Array.isArray(rows) || rows.length === 0) return;
  for (const g of rows) {
    await pool.query(
      `INSERT INTO game_guesses
         (user_id, username, usernode_pubkey, round_id, track, difficulty,
          guess_index, guess, distance, amount, guessed_at, tx_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
               CASE WHEN $11::double precision IS NULL THEN NULL
                    ELSE to_timestamp($11::double precision / 1000.0) END,
               $12)
       ON CONFLICT (user_id, round_id, guess_index) DO UPDATE SET
         username        = EXCLUDED.username,
         usernode_pubkey = EXCLUDED.usernode_pubkey,
         track           = EXCLUDED.track,
         difficulty      = EXCLUDED.difficulty,
         guess           = EXCLUDED.guess,
         distance        = EXCLUDED.distance,
         amount          = EXCLUDED.amount,
         guessed_at      = EXCLUDED.guessed_at,
         tx_id           = COALESCE(EXCLUDED.tx_id, game_guesses.tx_id)`,
      [
        user.id,
        user.username || null,
        user.usernode_pubkey || null,
        g.round_id,
        g.track || null,
        g.difficulty || null,
        g.guess_index,
        g.guess,
        g.distance != null ? g.distance : null,
        g.amount || 0,
        g.guessed_at != null ? g.guessed_at : null,
        g.tx_id || null,
      ]
    );
  }
}

// Fetch all of a user's saved per-guess rows, grouped into a map keyed by
// round_id with each round's guesses ordered by guess_index. Returns null when
// persistence is disabled so the caller can fall back to derived guesses.
// `guessed_at` is returned as epoch-ms to match the on-chain shape.
async function getGuessesForUser(userId) {
  if (!pool || !userId) return null;
  const { rows } = await pool.query(
    `SELECT round_id, guess_index, guess, distance, amount, tx_id,
            (EXTRACT(EPOCH FROM guessed_at) * 1000)::bigint AS guessed_at
       FROM game_guesses
      WHERE user_id = $1
      ORDER BY round_id DESC, guess_index ASC`,
    [userId]
  );
  const byRound = new Map();
  for (const r of rows) {
    if (!byRound.has(r.round_id)) byRound.set(r.round_id, []);
    byRound.get(r.round_id).push({
      guess_index: r.guess_index,
      guess: r.guess,
      distance: r.distance,
      amount: r.amount,
      tx_id: r.tx_id || null,
      guessed_at: r.guessed_at != null ? Number(r.guessed_at) : null,
    });
  }
  return byRound;
}

// Append one guess to the authoritative `guess_ledger`, keyed to its on-chain
// transaction id. Idempotent: ON CONFLICT (tx_id) DO NOTHING means the cache's
// boot-time stream replay (and any duplicate ingestion) is a safe no-op rather
// than a duplicate row. No-op when persistence is disabled. `tx` is the
// normalized guess shape assembled at the ingestion hook:
//   { tx_id, from_pubkey, round_id, track, difficulty, guess, amount, memo,
//     tx_timestamp (epoch-ms) }
async function appendGuess(tx) {
  if (!pool || !tx || !tx.tx_id || !tx.from_pubkey || tx.round_id == null) return;
  await pool.query(
    `INSERT INTO guess_ledger
       (tx_id, from_pubkey, round_id, track, difficulty, guess, amount, memo, tx_timestamp)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
             CASE WHEN $9::double precision IS NULL THEN NULL
                  ELSE to_timestamp($9::double precision / 1000.0) END)
     ON CONFLICT (tx_id) DO NOTHING`,
    [
      tx.tx_id,
      tx.from_pubkey,
      tx.round_id,
      tx.track || null,
      tx.difficulty || null,
      tx.guess,
      tx.amount || 0,
      tx.memo != null ? tx.memo : null,
      tx.tx_timestamp != null ? tx.tx_timestamp : null,
    ]
  );
}

// Read a player's ledger entries, newest-first, keyed by their wallet pubkey
// (chain identity). Returns null when persistence is disabled so callers can
// degrade. `tx_timestamp` is returned as epoch-ms to match the on-chain shape.
async function getLedgerForPubkey(pubkey) {
  if (!pool || !pubkey) return null;
  const { rows } = await pool.query(
    `SELECT tx_id, from_pubkey, round_id, track, difficulty, guess, amount, memo,
            (EXTRACT(EPOCH FROM tx_timestamp) * 1000)::bigint AS tx_timestamp
       FROM guess_ledger
      WHERE from_pubkey = $1
      ORDER BY tx_timestamp DESC NULLS LAST, round_id DESC`,
    [pubkey]
  );
  return rows.map((r) => ({
    tx_id: r.tx_id,
    from_pubkey: r.from_pubkey,
    round_id: r.round_id,
    track: r.track,
    difficulty: r.difficulty,
    guess: r.guess,
    amount: r.amount,
    memo: r.memo,
    tx_timestamp: r.tx_timestamp != null ? Number(r.tx_timestamp) : null,
  }));
}

// One-off cleanup of a blocked player's persisted history rows. The public
// surfaces (leaderboard/history) are filtered at the derivation layer in
// game-logic; this only clears the per-user `game_results` projection so the
// blocked player's own "My Games" tab doesn't keep showing stale rows. Matches
// by username and/or wallet pubkey. No-op when persistence is disabled.
async function purgeHiddenUsers({ usernames = [], pubkeys = [] } = {}) {
  if (!pool) return 0;
  const names = Array.from(usernames).filter(Boolean);
  const keys = Array.from(pubkeys).filter(Boolean);
  if (!names.length && !keys.length) return 0;
  const params = [names.length ? names : null, keys.length ? keys : null];
  const { rowCount } = await pool.query(
    `DELETE FROM game_results
      WHERE ($1::text[] IS NOT NULL AND username        = ANY($1))
         OR ($2::text[] IS NOT NULL AND usernode_pubkey = ANY($2))`,
    params
  );
  // Mirror the purge into the per-guess projection so a hidden player's guess
  // detail doesn't linger after their results rows are gone.
  const { rowCount: guessRowCount } = await pool.query(
    `DELETE FROM game_guesses
      WHERE ($1::text[] IS NOT NULL AND username        = ANY($1))
         OR ($2::text[] IS NOT NULL AND usernode_pubkey = ANY($2))`,
    params
  );
  if (rowCount || guessRowCount) {
    console.log(`[db] purged ${rowCount} game_results + ${guessRowCount} game_guesses row(s) for hidden user(s)`);
  }
  return rowCount + guessRowCount;
}

// Record (or refresh) one optimistic pending guess for a user. Idempotent: the
// unique (user_id, round_id, guess) constraint means a re-tap of the same guess
// refreshes `placed_at` rather than duplicating the row. `username` /
// `usernode_pubkey` are refreshed on every write so a rename propagates. No-op
// when persistence is disabled. `g` is `{ round_id, track, difficulty, guess }`.
async function upsertPendingGuess(user, g) {
  if (!pool || !user || !user.id || !g || g.round_id == null || g.guess == null) return;
  await pool.query(
    `INSERT INTO pending_guesses
       (user_id, username, usernode_pubkey, round_id, track, difficulty, guess, status, placed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending', now())
     ON CONFLICT (user_id, round_id, guess) DO UPDATE SET
       username        = EXCLUDED.username,
       usernode_pubkey = EXCLUDED.usernode_pubkey,
       track           = EXCLUDED.track,
       difficulty      = EXCLUDED.difficulty,
       status          = 'pending',
       placed_at       = now()`,
    [
      user.id,
      user.username || null,
      user.usernode_pubkey || null,
      g.round_id,
      g.track || null,
      g.difficulty || null,
      g.guess,
    ]
  );
}

// Fetch a user's pending guesses, newest-first. Returns null when persistence is
// disabled so the caller can degrade to an empty list. `placed_at` is returned
// as epoch-ms to match the on-chain shape the frontend expects.
async function getPendingGuessesForUser(userId) {
  if (!pool || !userId) return null;
  const { rows } = await pool.query(
    `SELECT round_id, track, difficulty, guess, status,
            (EXTRACT(EPOCH FROM placed_at) * 1000)::bigint AS placed_at
       FROM pending_guesses
      WHERE user_id = $1
      ORDER BY placed_at DESC, round_id DESC`,
    [userId]
  );
  return rows.map((r) => ({
    roundId: r.round_id,
    track: r.track,
    difficulty: r.difficulty,
    guess: r.guess,
    status: r.status,
    placedAt: r.placed_at != null ? Number(r.placed_at) : null,
  }));
}

// Delete one pending guess for a user (called when the guess is cancelled /
// declined on the client, or lazily pruned by the GET endpoint once it has
// landed on-chain / its round rolled / it aged out). No-op when disabled.
async function deletePendingGuess(userId, roundId, guess) {
  if (!pool || !userId || roundId == null || guess == null) return;
  await pool.query(
    `DELETE FROM pending_guesses WHERE user_id = $1 AND round_id = $2 AND guess = $3`,
    [userId, roundId, guess]
  );
}

module.exports = {
  isEnabled,
  initSchema,
  upsertResults,
  getResultsForUser,
  upsertGuesses,
  getGuessesForUser,
  appendGuess,
  getLedgerForPubkey,
  purgeHiddenUsers,
  upsertPendingGuess,
  getPendingGuessesForUser,
  deletePendingGuess,
};
