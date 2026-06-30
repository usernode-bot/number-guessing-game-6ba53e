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
  console.log('[db] game_results + game_guesses schema ready');
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
          guess_index, guess, distance, amount, guessed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
               CASE WHEN $11::double precision IS NULL THEN NULL
                    ELSE to_timestamp($11::double precision / 1000.0) END)
       ON CONFLICT (user_id, round_id, guess_index) DO UPDATE SET
         username        = EXCLUDED.username,
         usernode_pubkey = EXCLUDED.usernode_pubkey,
         track           = EXCLUDED.track,
         difficulty      = EXCLUDED.difficulty,
         guess           = EXCLUDED.guess,
         distance        = EXCLUDED.distance,
         amount          = EXCLUDED.amount,
         guessed_at      = EXCLUDED.guessed_at`,
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
    `SELECT round_id, guess_index, guess, distance, amount,
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
      guessed_at: r.guessed_at != null ? Number(r.guessed_at) : null,
    });
  }
  return byRound;
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

module.exports = {
  isEnabled,
  initSchema,
  upsertResults,
  getResultsForUser,
  upsertGuesses,
  getGuessesForUser,
  purgeHiddenUsers,
};
