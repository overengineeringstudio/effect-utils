# Capture-then-delete: safety never depends on classifying dirt

## Status

accepted — capture-before-delete principle stands; the holding location moved
from `$STORE/.state/trash/` to `<repo>/.archive/` (superseded on location by
[0007](0007-archive-is-the-trash.md)).

## Context

A real-store survey proved that classifying uncommitted changes as "generated"
vs "source" by path is unreliable in both directions (`src/build/app.ts` matched
a `build/` pattern but is hand-written; `*.d.ts.map` / `*.genie.js` are generated
but matched no pattern). `mr` is generic and cannot reliably know a repo's
generated-file set. Yet nearly every cold worktree carries ~10 dirty files of
regenerated drift, so "any dirt blocks deletion" reclaims almost nothing.

## Decision

Deletion safety must NOT depend on the gen/source classifier. Before deleting a
cold worktree that has any uncommitted change, capture the uncommitted state into
a recoverable store-side trash with a retention TTL (e.g. move the worktree under
`$STORE/.state/trash/<repo>/<ref>-<ts>/`, or persist a diff patch + untracked
tarball). Only then remove it. Clean worktrees (nothing to lose, and committed
work already durable per the lossless floor) may be hard-deleted directly.

"Generated vs source" is demoted to a UX-only filter: known-regenerable drift
(lockfiles, declared genie outputs) need not be stashed and need not be reported
as risk — but mis-classifying it never causes data loss.

## Consequences

- Provably lossless regardless of classifier accuracy.
- Trash consumes disk until its TTL expires, partially deferring reclaim for
  dirty worktrees; the dominant win (clean, merged worktrees → hard delete) is
  unaffected. Trash is itself GC'd by age.
- Recovery story: a wrongly-deleted dirty worktree is restorable from trash
  within the TTL.
