# Cross-megarepo membership vetoes stale-worktree deletion

## Status

accepted (safety invariant)

## Context

The store is shared by independent megarepo workspaces. A worktree that looks
stale in isolation (merged PR, old, clean) may still be an active member of a
_different_ megarepo. Deleting it would break that workspace.

Protection today rides on the store liveness registry (`.state/workspaces/
<hash>.json`): each workspace records its consumed store paths (`livePaths`,
derived from `repos/` symlinks + lock). `collectStoreLiveSet` unions all
registered records. Verified live: in `default` mode a detached commit worktree
consumed by workspace B is skipped when B is registered.

Two structural limits (verified / being verified end-to-end):

1. The registry is a per-workspace **cache**, refreshed only when that workspace
   runs an `mr` command. A workspace that exists but has never run `mr` (or whose
   record is stale) contributes nothing to the live set — its members are
   unprotected.
2. The two existing GC modes can't express the needed gate: `default` blanket-
   protects every named branch (so liveness is moot for them); `--all` ignores
   the live set entirely (protects nothing). Neither honors "delete a named
   branch _only if_ no workspace consumes it."

## Decision

Cross-megarepo membership is a **hard veto** on deletion: a worktree referenced
by ANY workspace's live set is never deleted, even if it independently satisfies
the lossless+staleness gate. The new stale-deletion policy is a THIRD mode
(distinct from `default` and `--all`) that consults the live set for named
branches too.

The registry-completeness gap (limit 1) is itself a safety problem and must be
closed or bounded before stale named-branch deletion is enabled (see the
freshness/heartbeat decision).

## Verified (end-to-end, isolated store — tmp/gc-exp/xmatrix-findings.md)

Real `mr` binary, isolated store, gc run from a workspace that does NOT consume
the target detached-commit worktree C:

- Registered consumer ⇒ C `skipped_in_use` ("referenced by workspace root set").
  Protection unions livePaths of ALL registered workspaces. Works.
- Unregistered / deleted-record consumer ⇒ C `removed` (real gc physically
  deleted it). A `repos/` symlink ALONE gives zero protection — gc never
  live-scans other workspaces' symlinks.
- Only `mr status` / `mr store status` refresh a record; `mr store gc` (even
  dry-run), `ls`, `check`, `root` do NOT. Records go stale easily.
- **Latent pre-existing bug:** after a workspace repins to a new target without
  re-registering, gc over-protects the abandoned worktree AND _under-protects
  the new in-use target_ (deletes a worktree a live workspace is actually using).
  This already exists for commit worktrees today, independent of this feature.

## Consequences

- The live-set gate must precede the lossless/staleness checks and use the
  store-wide registry (`collectStoreLiveSet`), not just the current workspace.
- Stale deletion cannot reuse `--all` semantics.
- A consumer that never registers is the dominant residual risk; mitigations
  (more commands refresh the record; freshness gate; conservative default)
  are required, not optional.
- The repin-without-reregister under-protection (verified) must be closed: more
  commands must refresh, and/or gc must reconcile registered workspaces before
  deleting.
