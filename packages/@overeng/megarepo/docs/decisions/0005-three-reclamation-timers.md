# Three reclamation timers

## Status

accepted

## Context

The liveness and staleness gates decide whether a worktree may be reclaimed. The
timers decide how long completed work lingers before archive or deletion.

## Decision

GC uses three host-overridable timers from `$STORE/.state/gc-config.json`:

- absence grace: default 14d continuously absent from all live sets before archive
- post-merge grace: default 7d after `mergedAt` before archive
- archive retention TTL: default 30d from archive to hard delete

A worktree is archived only when every policy gate and applicable timer passes.
An archive is reaped only after retention TTL.

## Consequences

- Continuous absence is stored in a persisted observation ledger.
- `--dry-run` must not persist observations, because planning runs must not
  advance the archive clock.
- The first real run archives nothing when the ledger is empty.
