# Reclaim cold named-branch worktrees in default GC

## Status

accepted (supersedes the original artifact-pruning scope of #771)

## Context

Default `mr store gc` previously protected every `refs/heads/*` and
`refs/tags/*` worktree, so it could collect only detached commit worktrees. The
cold population is mostly named branches, while artifact-pruning in-place would
leave the main accumulation untouched.

## Decision

Default `mr store gc` deletes cold named-branch worktrees after all safety gates
pass. `--all` remains the explicit protection-bypassing mode. Artifact pruning is
out of scope for this decision.

The gate order is:

1. cross-megarepo live-set veto ([0002](0002-cross-megarepo-liveness-veto.md))
2. staleness = merged or closed PR, never the default branch ([0004](0004-staleness-merged-or-closed-pr.md))
3. lossless floor plus archive capture ([0003](0003-lossless-capture-via-archive.md))
4. grace timers and archive retention ([0005](0005-three-reclamation-timers.md))

## Consequences

- The policy is conservative because a false positive can lose local work.
- Deletions must be visible and recoverable in output; `--dry-run --json` is the
  planning surface.
- Default-on accepts GitHub/fetch cost; without GitHub access or stale PRs,
  behavior degrades to keep.
