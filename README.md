# Number Guessing Game

A fully on-chain number-guessing game on [Usernode Social Vibecoding](https://social-vibecoding.usernodelabs.org).

Players pick a number between 1 and 100. Each guess costs 1 token. When the round ends, the closest guess wins the entire pot. Ties go to the earliest submission. All state is reconstructed from on-chain memo transactions — no server database required.

## How it works

1. Each round has a published `seed_hash` (64-char hex generated server-side).
2. When the timer expires, the secret is revealed: `secret = (parseInt(seed_hash.slice(0,8), 16) % 100) + 1`.
3. The player with the closest guess wins the pot. Equal distance → earliest timestamp wins.
4. If fewer than `MIN_PLAYERS` have guessed when the timer expires, the round extends.

## Development

This app has no local mock/fake-data mode — it always talks to the real
Usernode network through the centrally hosted bridge and the live username
system. Develop and review against a **staging** build (every PR spins up a
staging container, seeded with demo rounds and usernames), or run the server
with `USERNODE_ENV=staging` pointed at a reachable node via `NODE_RPC_URL`.

```bash
cp .env.example .env
npm install
# Staging-style boot: seeds demo data, uses the real bridge for chain access.
USERNODE_ENV=staging DATABASE_URL=... NODE_RPC_URL=... node server.js
```

Open `http://localhost:3000`. Bridge-touching paths (`getNodeAddress`,
`sendTransaction`, chain discovery) require the platform to be reachable.

## Production

Set `APP_PUBKEY` and `APP_SECRET_KEY` in the Usernode Secrets modal. The platform injects `DATABASE_URL`, `JWT_SECRET`, `PORT`, and `USERNODE_ENV` automatically.

```bash
node server.js
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `APP_PUBKEY` | — | On-chain game wallet address (required) |
| `APP_SECRET_KEY` | — | Signing key for server-side payouts (required) |
| `NODE_RPC_URL` | `http://usernode-node:3000` | Sidecar RPC endpoint |
| `TIMER_DURATION_MS` | `86400000` | Round duration in ms (24h) |
| `MIN_PLAYERS` | `2` | Min players before round can end |

## Memo formats

All game state lives on-chain as JSON memos on transactions to/from `APP_PUBKEY`.

| Type | Direction | Purpose |
|---|---|---|
| `start_round` | app → app | Opens a new round with `seed_hash` |
| `guess` | player → app | Player's number guess (1–100), costs 1 token |
| `end_round` | app → app | Reveals `secret`, records winner and pot |
| `payout` | app → winner | Transfers the pot to the winner |
