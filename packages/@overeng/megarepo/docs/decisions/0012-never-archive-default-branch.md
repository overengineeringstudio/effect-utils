# Never archive a repo's default branch + validation outcomes

## Status

accepted (from dry-run validation)

## Context

Manual dry-run validation drove the real branch CLI against isolated stores (all
9 scenarios passed) and projected the classifier, read-only, over the real store
(281 named worktrees). Two things emerged worth deciding/recording.

The validation surfaced a concrete hazard: `ai/nanoid main` — a vendored
dependency's default branch — was steady-state archive-eligible, because the
PR-state join matched an old upstream PR whose `headRefName` was `main`, and the
worktree was not in any recorded live set. Archiving a dependency's default
branch is never wanted, and common names (`main`/`master`) are exactly the ones
prone to PR-join false positives.

## Decision

Add a hard **default-branch guard**: a worktree whose ref equals its repo's
default branch is NEVER reclaimed by the cold path, independent of PR state and
liveness. The default branch is read locally and offline from the bare repo's
`HEAD` symbolic ref (`Git.getStoreDefaultBranch`), so it costs no extra network.
The guard runs before any staleness/liveness logic (keep reason `default-branch`).

## Validation outcomes (other levers — decided to leave as-is)

- **Stash stays repo-global** (the dominant suppressor: 146/151 keeps). Per-worktree
  stash would lift eligibility from 6 to ~61 worktrees (~7.9G), but it was kept
  repo-global: the over-keep is conservative (never risks a stash) and per-worktree
  attribution is fuzzy. Confirms decision 0004/B3 granularity intentionally.
- **Default-on stands** (decision 0006): the per-run cost (~31 fetch + ~31 gh) is
  accepted even though steady-state reclaim is modest.
- **Worktree-deletion is the accepted scope**: validation showed it reclaims
  ~90M–7.9G while ~445G sits in `node_modules`/`target` of legitimately-kept
  worktrees. Artifact-pruning (#771's original framing) is explicitly NOT pursued;
  bulk disk is handled by other means. Reaffirms [0001](0001-gc-reclaims-cold-named-worktrees.md).
- **First real run archives nothing** (14d absence-grace bootstrap) — accepted as
  the deliberate slow-to-first-archive behaviour.

## Consequences

- One extra local `symbolic-ref` read per repo on the cold path (negligible).
- A dependency's default branch is safe even when the liveness registry is stale —
  a belt-and-suspenders complement to the cross-megarepo veto.
