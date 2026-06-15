# Cross-megarepo liveness is a hard veto, trusted with margins, reconciled before delete

## Status

accepted (safety invariant; also closes a verified pre-existing bug)

## Context

The store is shared by independent megarepo workspaces, so a worktree that looks
stale in isolation may be an active member of a _different_ megarepo. Protection
rides on the store liveness registry (`.state/workspaces/<hash>.json`): each
workspace records its consumed store paths (`livePaths`, from `repos/` symlinks +
lock); `collectStoreLiveSet` unions all registered records.

The registry is a per-workspace **cache**, fresh only for workspaces that have run
an `mr` command — building an authoritative global workspace index was rejected as
heavy infra with the same chicken-and-egg. A key mitigation: the lossless floor
([0003](0003-lossless-capture-via-archive.md)) already prevents _data loss_ in the
cross-megarepo case (a wrongly deleted member that passed the floor is
re-materializable via `mr apply`), so the veto is mostly about _availability_,
plus the deleted-remote-branch edge.

Verified end-to-end (real `mr`, isolated store; `tmp/gc-exp/xmatrix-findings.md`):
a registered consumer's worktree is skipped; an unregistered / deleted-record
consumer's is removed (a `repos/` symlink ALONE gives zero protection — gc never
live-scans other workspaces' symlinks); only `mr status`/`mr store status` refresh
a record. This exposed a **pre-existing bug**: a workspace that repins a member
without re-registering has a stale record, so gc over-protects the abandoned
target AND deletes the new in-use one.

## Decision

1. **Hard veto.** A worktree in ANY registered workspace's live set is never
   deleted, even if it satisfies lossless+staleness. This gate precedes the others
   and uses the store-wide registry — `--all` semantics cannot be reused.
2. **Trust the registry, bounded by margins** (not new infra): refresh the record
   on more `mr` commands; require continuous absence across the grace window
   ([0005](0005-three-reclamation-timers.md)), not one snapshot; refuse-when-uncertain.
3. **Reconcile-all before delete.** Before any deletion, gc re-derives EVERY
   registered workspace's live paths fresh from disk (not just the current one),
   deterministically catching repins — closing the verified bug. A present-but-
   unreadable workspace fails safe (keep last-known paths); a vanished one is pruned.
4. **Broaden refresh triggers** (`apply`/`sync`/`pull`/`pin` + gc's own invoker).

## Consequences

- Residual risk shrinks to a workspace that has LITERALLY never run `mr` (no
  record) — accepted, bounded by the grace window and lossless re-apply.
- Reconcile cost scales with the registered-workspace count (cheap symlink/file
  reads), on the destructive path only.
- The deleted-remote-branch edge is handled in the lossless floor: require "commit
  reachable on a remote", not merely "branch was pushed once".
