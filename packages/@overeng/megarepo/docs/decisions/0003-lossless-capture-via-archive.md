# Lossless capture via `.archive/`

## Status

accepted

## Context

Path-based classification of dirty files as generated vs source is unreliable in
a generic repository manager. Blocking on any dirt reclaims little, but deleting
dirt directly can lose user work.

The store already has an `.archive/` convention: move a worktree aside while
keeping its files and git metadata recoverable.

## Decision

Deletion safety depends on a lossless floor, not on classifying dirt:

- every local commit is reachable from a remote after fetch
- there are no unpushed commits
- there is no stash in the bare repository
- uncommitted and untracked files travel with the archived worktree

A qualifying worktree is moved to `<repo>/.archive/<name>/`, its branch ref is
freed so `mr apply` can re-materialize it, and the archive is hard-deleted only
after the retention TTL ([0005](0005-three-reclamation-timers.md)).

## Consequences

- A wrongly archived worktree stays restorable until retention reaping.
- GC must scan `.archive/` and must re-check the cross-megarepo veto under lock
  before reaping.
- Stash detection stays repo-global; it over-keeps but never risks losing a
  stash.
