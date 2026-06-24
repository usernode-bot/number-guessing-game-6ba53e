'use strict';

// ---------------------------------------------------------------------------
// Hidden players — single source of truth for who is filtered out of every
// public view (leaderboard, history winner credit, result cards, the shared
// username directory).
//
// Hiding is config-driven, NOT a true on-chain deletion: chain data is
// immutable and the leaderboard is recomputed from it on every read, so the
// only durable way to keep a player out of public views is to filter them at
// the derivation/state layer. To a normal user the effect is indistinguishable
// from removal.
//
// A player can be hidden two ways:
//   - by pubkey (stable, preferred) — listed in HIDDEN_PUBKEYS, or learned at
//     runtime once a hidden username resolves to a pubkey (addHiddenPubkey).
//   - by username — listed in HIDDEN_USERNAMES (default: user_vedge). The
//     server resolves these to pubkeys from the live usernames cache as
//     set_username transactions are ingested, then calls addHiddenPubkey so
//     the chain-derived game state (keyed by pubkey) can filter them too.
//
// Overridable via env (comma-separated):
//   HIDDEN_PUBKEYS    — ut... wallet pubkeys to hide outright
//   HIDDEN_USERNAMES  — display names to hide (defaults to "user_vedge")
//
// This is a one-off moderation knob, not an admin capability. A real
// add/remove-at-runtime moderation surface is deferred work.
// ---------------------------------------------------------------------------

function parseList(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const DEFAULT_HIDDEN_USERNAMES = ['user_vedge'];

const envUsernames = parseList(process.env.HIDDEN_USERNAMES);
const hiddenUsernames = new Set(envUsernames.length ? envUsernames : DEFAULT_HIDDEN_USERNAMES);
const hiddenPubkeys = new Set(parseList(process.env.HIDDEN_PUBKEYS));

// Register a pubkey as hidden once it has been resolved (e.g. from a hidden
// username). Idempotent.
function addHiddenPubkey(pubkey) {
  if (pubkey) hiddenPubkeys.add(pubkey);
}

function isHiddenPubkey(pubkey) {
  return !!pubkey && hiddenPubkeys.has(pubkey);
}

function isHiddenUsername(name) {
  return !!name && hiddenUsernames.has(name);
}

// Resolve hidden usernames against a pubkey -> username map (the shape returned
// by the usernames cache's getStateResponse().usernames). Any match is added to
// the hidden-pubkey set so chain-derived state can filter it. Returns the set of
// pubkeys newly-or-already hidden by name, for callers that want to log/act.
function resolveHiddenFromUsernameMap(usernameMap) {
  const resolved = [];
  if (!usernameMap) return resolved;
  for (const pubkey of Object.keys(usernameMap)) {
    if (isHiddenUsername(usernameMap[pubkey])) {
      addHiddenPubkey(pubkey);
      resolved.push(pubkey);
    }
  }
  return resolved;
}

module.exports = {
  hiddenPubkeys,
  hiddenUsernames,
  addHiddenPubkey,
  isHiddenPubkey,
  isHiddenUsername,
  resolveHiddenFromUsernameMap,
};
