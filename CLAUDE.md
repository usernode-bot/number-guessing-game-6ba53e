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
- **The one database table is `game_results`** (see `lib/db.js`): a
  durable, per-user projection of each authenticated player's finished
  rounds (guess count, win/outcome, best guess/distance, pot, timestamp),
  keyed to `req.user`. It's written lazily when a signed-in player reads
  their history via `GET /api/my-history`, and read back for the "My
  Games" tab. The table is **public** (every field is already public
  on-chain) and the schema is applied idempotently on boot via
  `db.initSchema()`. `DATABASE_URL` is platform-injected; if it's absent
  the history endpoint degrades to freshly-derived (unsaved) results
  rather than failing. Keep deriving *gameplay* state from the chain —
  only durable per-user records belong in `game_results`.

_(optional — e.g. "all currency values stored as integer cents, not
floats"; "the `posts` table is append-only"; "avoid adding new
dependencies"; etc.)_
