# Three reclamation timers: absence grace, post-merge grace, archive retention

## Status

accepted (default values proposed, host-overridable via `$STORE/.state/gc-config.json`)

## Context

The live-set veto already protects actively-used worktrees, so the timers only
shape how long after work ends a worktree lingers. Real-store data: most merged
worktrees are 30–120 days old, but a few merges are 2–5 days old — so a generous
window spares fresh merges at near-zero reclaim cost. A two-timer model was
considered; three were chosen for explicit control over just-merged branches.

## Decision

Three independent timers gate reclamation:

1. **Absence grace** (default 14d): continuously absent from ALL live sets this
   long before eligible to archive (guards a consumer that hasn't re-registered).
2. **Post-merge grace** (default 7d): even once merged + lossless + absent, do not
   archive until this long after the PR's `mergedAt` (protects follow-up work).
3. **Archive retention TTL** (default 30d): an archived worktree is reaped this
   long after archiving.

A worktree is archived only when ALL hold: cross-megarepo veto passes, not the
default branch, lossless, merged/closed, absence-grace and (for merged)
post-merge-grace satisfied. It is reaped only after the retention TTL.

## Consequences

- "Continuous absence" is tracked against a persisted observation ledger, not a
  single snapshot; the ledger advances only on real runs (`--dry-run` must not
  persist it, or it would advance the clock for a planning-only run).
- **First real run archives nothing** (accepted): the ledger starts empty, so
  everything hits the absence-grace gate — deliberate slow-to-first-archive.
- Worst-case "done"→reclaimed ≈ max(absence, post-merge) + retention (~37–44d with
  defaults), acceptable since the dominant cold population is far older.
