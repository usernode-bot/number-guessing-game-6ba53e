# Number Guessing Game — notes for Claude Code

This app runs on **Usernode Social Vibecoding**. If you're Claude Code
editing this repo, read the platform conventions before making
changes:

**Platform conventions (authoritative, always current):**
https://social-vibecoding.usernodelabs.org/claude.md

Fetch that URL at the start of each session — it's the single source
of truth for platform-wide behavior (auth model, `USERNODE_ENV`,
public/private tables, "don't `git push`", etc.). The hosted copy is
updated in place when platform rules change, so fetching it gives you
today's rules, not a stale snapshot.

When running inside Usernode's dev-chat, those same conventions are
already injected into your system prompt, so the fetch is a no-op in
that path — but it's the right reflex when someone runs Claude Code
against this repo locally or from another harness.

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About Number Guessing Game

_(add a sentence or two of product context here so Claude Code has a
shared understanding of what this app is for)_

## App-specific conventions

- **Live gameplay is on-chain; per-user history is in Postgres.**
  Rounds, guesses, results, scores/leaderboard, and per-track win
  streaks are all derived from Usernode transactions to/from
  `APP_PUBKEY`; win streaks are computed on read in `game-logic.js`
  (`getMyStreaks` / `getTrackStreaks`). The chain remains the source of
  truth for live state — derive new gameplay state from chain data, not
  a table.
- **There are four Postgres tables** (see `lib/db.js`), all **public**
  (every field is already public on-chain) and all applied idempotently
  on boot via `db.initSchema()`:
  - **`game_results`** — a durable, per-user projection of each
    authenticated player's finished rounds (guess count, win/outcome,
    best guess/distance, pot, timestamp), keyed to `req.user`.
  - **`game_guesses`** — the per-guess companion to `game_results`: one
    row per individual guess in a finished round, also keyed to
    `req.user`, now carrying the guess's on-chain `tx_id`.
  Both of the above are written **lazily** when a signed-in player reads
  their history via `GET /api/my-history`, and read back for the "My
  Games" tab.
  - **`guess_ledger`** — the authoritative, **append-only** capture of
    every guess from every player, keyed by its on-chain transaction id
    (`tx_id` UNIQUE) and the sender wallet (`from_pubkey`). Unlike the two
    projections above, it is written from the server's transaction stream
    (`processTransactionWithLedger` → `db.appendGuess`) as each guess tx is
    ingested — for active and finished rounds alike, regardless of whether
    the player ever opens their history. `ON CONFLICT (tx_id) DO NOTHING`
    makes the cache's boot-time replay a safe, self-healing backfill, so
    the ledger can be processed and replayed from chain.
  - **`pending_guesses`** — a short-lived, per-user cache of a player's
    OPTIMISTIC (not-yet-confirmed) guesses, keyed to `req.user` with a
    UNIQUE `(user_id, round_id, guess)`. It exists only so a page refresh
    during the tap→on-chain-inclusion window can rehydrate the dimmed
    "placing…" row instead of losing it (`POST /api/pending-guess` on
    placement, `GET /api/pending-guesses` on boot, `DELETE
    /api/pending-guess` on wallet-decline). It is a convenience cache, NOT
    authoritative — confirmed state still derives from chain, and the GET
    endpoint self-prunes rows that have landed on-chain, whose round
    rolled/ended, or that aged out past ~10 min.
  `DATABASE_URL` is platform-injected; if it's absent every `db` function
  becomes a no-op and the history endpoint degrades to freshly-derived
  (unsaved) results rather than failing. Keep deriving *gameplay* state
  from the chain — only durable per-user records and the ledger belong in
  Postgres.

- **Vendored divergence — `lib/dapp-server.js` `handleExplorerProxy`
  has a request timeout.** The upstream copy proxies explorer requests
  with no socket timeout, so a stalled/black-holed explorer host would
  hang the wallet bridge's post-send inclusion poll indefinitely —
  surfacing as "Place Guess spins forever and returns nothing." We
  added an `opts.timeoutMs` (passed as `12000` from `server.js`) that
  aborts the upstream request and returns `504` so the client falls
  back to `/__numguess/state` reconciliation. If you ever re-vendor
  this file from `usernode-dapp-starter`, **re-apply the timeout** (or,
  better, upstream it to canonical first) — dropping it reintroduces
  the hang.

_(optional — e.g. "all currency values stored as integer cents, not
floats"; "the `posts` table is append-only"; "avoid adding new
dependencies"; etc.)_
