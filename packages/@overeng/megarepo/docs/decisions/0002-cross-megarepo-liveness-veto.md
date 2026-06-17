# Cross-megarepo liveness is a hard veto

## Status

accepted

## Context

The store is shared by independent megarepo workspaces. A worktree that is stale
for the current workspace may still be active elsewhere. Liveness comes from the
store registry (`.state/workspaces/<hash>.json`), where each workspace records
the store paths it consumes.

The registry is a cache, not an authoritative workspace index. A stale registry
record can over-protect old paths and miss a repinned in-use path unless GC
reconciles registered workspaces before deleting.

## Decision

- A worktree in any registered workspace live set is never deleted, even if every
  other gate passes.
- Before deletion, GC re-derives every registered workspace's live paths from
  disk. Present-but-unreadable workspaces fail safe by keeping last-known paths;
  vanished workspaces are pruned.
- Liveness records are refreshed by ordinary mutating/read commands
  (`apply`, `sync`, `pull`, `pin`, status, and GC).
- Continuous absence across the grace window is required; one missing snapshot
  never licenses deletion.

## Consequences

- The remaining availability risk is a workspace that has never registered with
  `mr`; the lossless floor still prevents data loss for re-materializable refs.
- Reconcile cost scales with registered workspace count and is paid only on the
  destructive path.
