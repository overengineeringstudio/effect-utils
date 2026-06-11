# Three reclamation timers: absence grace, post-merge grace, archive retention

## Status

accepted (default values proposed, tunable)

## Context

Reclamation is time-gated. The live-set veto already protects actively-used
worktrees, so the timers only shape how long after work ends a worktree lingers.
Real-store data: most merged worktrees are 30–120 days old, but a few merges are
2–5 days old — so a generous window spares fresh merges at near-zero reclaim cost.

A two-timer model (absence + retention) was considered; the three-timer model was
chosen to give explicit, separate control over just-merged branches.

## Decision

Three independent timers gate reclamation:

1. **Absence grace** (default 14d): a worktree must be continuously absent from
   ALL live sets for this long before it is eligible to archive. Guards against a
   consumer that simply hasn't re-registered recently.
2. **Post-merge grace** (default 7d): even once merged + lossless + absent, do not
   archive until at least this long after the PR's `mergedAt`. Protects follow-up
   work on a freshly merged branch.
3. **Archive retention TTL** (default 30d): an archived worktree is reaped
   (hard-deleted) once it has been archived this long.

A worktree is archived only when ALL of: cross-megarepo veto passes, lossless,
merged, absence-grace satisfied, AND post-merge-grace satisfied. It is reaped only
after retention TTL.

## Consequences

- Three host-overridable config values; defaults are conservative-generous
  because the cold population is mostly much older than the windows.
- Post-merge grace requires the PR `mergedAt` timestamp from the staleness
  resolver, not just the merged boolean.
- Total worst-case lifetime from "done" to disk reclaimed ≈ max(absence,
  post-merge) + retention (~37–44d with defaults); acceptable given the dominant
  win is the large, much-older population.
