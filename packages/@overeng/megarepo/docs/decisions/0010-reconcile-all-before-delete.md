# Reconcile all workspaces before a destructive GC; broaden refresh triggers

## Status

accepted (also fixes a verified pre-existing bug)

## Context

End-to-end experiments proved a pre-existing data-availability bug: only
`mr status` / `mr store status` refresh a workspace's liveness record. A
workspace that repins a member to a new target and runs no refreshing command
before a concurrent gc has a STALE record — gc then over-protects the abandoned
target and _deletes the new in-use target_ (verified: commit worktree D removed
while a live workspace consumed it). With named-branch deletion enabled this risk
extends to branches.

Each registry record carries its `workspaceRoot`, and a workspace's true live
paths are always derivable from its on-disk `repos/` symlinks + lock — so gc can
re-derive them rather than trust a possibly-stale cached `livePaths`.

## Decision

Two changes:

1. **Reconcile-all before delete.** Before any named-branch deletion, gc
   re-derives EVERY registered workspace's live paths fresh from disk (not just
   the current workspace's), then computes the live set. Deterministically
   catches repins regardless of whether that workspace ran a command.
2. **Broaden refresh triggers.** More `mr` commands refresh the current
   workspace's record (e.g. `apply`, `sync`, `pull`, `pin`, and gc for its own
   invoking workspace), so workspaces register earlier and records stay fresh.

## Consequences

- Reconcile cost scales with the number of registered workspaces (bounded, cheap
  file/symlink reads); acceptable on the destructive path, not the hot path.
- Residual risk shrinks to a workspace that has LITERALLY never run any `mr`
  command (no record at all) — bounded by the grace window and lossless re-apply.
- This closes the verified bug as part of this work; no separate issue needed.
- A reconcile that finds a workspace dir gone prunes its record (existing
  behaviour); a workspace dir present but unreadable should fail safe (treat its
  last-known paths as live).
