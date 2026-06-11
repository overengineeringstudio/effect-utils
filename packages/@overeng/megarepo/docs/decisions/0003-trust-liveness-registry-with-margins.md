# Trust the liveness registry, bounded by safety margins

## Status

accepted

## Context

Cross-megarepo protection rides on the per-workspace liveness registry, which is
a cache (only fresh for workspaces that have run `mr`). Building an authoritative
global workspace index was considered and rejected as heavy new infrastructure
with the same chicken-and-egg for never-seen workspaces.

A key mitigating fact: the lossless floor (fully pushed + no uncommitted source)
already prevents _data loss_ in the cross-megarepo case — a wrongly deleted
member that passed the floor is re-materializable via `mr apply`. The veto is
therefore mostly about _availability_ (don't disrupt an active consumer) plus one
real edge: a squash-merged branch deleted from its remote may have an
unreachable commit, so re-fetch can fail.

## Decision

Trust the registry as the cross-megarepo signal, bounded by margins rather than
replaced by new infrastructure:

- Refresh the current workspace's registry record on more `mr` commands (cheap)
  so records stay fresh in normal use.
- Gate stale named-branch deletion on registry freshness (a TTL / heartbeat) and
  refuse-when-uncertain (fall back to keeping the worktree).
- Require a worktree be continuously absent from ALL live sets across a grace
  window before it is deletable (see staleness/grace-window decision), not just
  absent in one snapshot.

## Consequences

- The residual risk is a consumer that has literally never run `mr`; this is
  accepted, bounded by the grace window and the re-apply recoverability of
  lossless worktrees.
- The deleted-remote-branch edge needs explicit handling in the lossless floor
  (prefer "commit reachable on remote", not merely "branch was pushed once").
