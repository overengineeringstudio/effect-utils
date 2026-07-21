# CI Store Cache Requirements

## Context

The CI store cache is the CI-profile realization of dependency materialization:
how generated CI workflows persist and restore the pnpm store/home/state across
runs so jobs reuse dependency content instead of re-fetching it. It refines the
root contract for the CI profile named in
[../requirements.md](../requirements.md) (A03) and the store authority contract
in [../04-store-authority/requirements.md](../04-store-authority/requirements.md).

Its correctness concern is not purity but **write coordination and disk
safety** on shared self-hosted runners: an uncoordinated cache that many jobs
write to exhausts runner disk, while a cache no job writes to never warms.

## Assumptions

- **A01 CI profile:** CI jobs are a dependency materialization profile consumer
  sharing the root profile vocabulary. Builds on
  [../requirements.md](../requirements.md) A03 and the `ciJobLocal` store trait
  (DMP-R12).
- **A02 Actions cache backend:** The persistence backend is a keyed
  save/restore cache (GitHub Actions cache semantics) on self-hosted runners
  with bounded, shared disk.
- **A03 Pre-checkout clean:** Checkout wipes a gitignored workspace path before
  jobs run, so any workspace-local store must be restored after checkout.

## Acceptable Tradeoffs

- **T01 Cold rebuild on version bump:** A centralized cache-version bump forces
  a one-time cold store rebuild per consumer. A single convergent version bump
  is preferred over per-repo ad hoc invalidation.
- **T02 Publisher coupling:** Designating one publisher job couples cache
  warming to that job's trigger set; the choice must be verified per repo
  (R05).

## Requirements

### Must place the store deterministically

- **DMP.CICACHE-R01 Workspace-relative store:** The CI pnpm store, home, and
  state must live at stable workspace-relative paths so they persist across a
  job's steps and are addressable by save/restore.
  Refines: DMP-R12, DMP.STORE-R02.
- **DMP.CICACHE-R02 Restore after checkout:** Store restore must run after the
  checkout that wipes the gitignored workspace path, or the restored content is
  discarded.
  Refines: DMP.STORE-R05.

### Must coordinate exactly one writer

- **DMP.CICACHE-R03 Single publisher per key:** For each cache key, exactly one
  job in a workflow saves the cache — never zero (the key never warms), never
  many (concurrent writers exhaust shared runner disk).
  Refines: DMP.STORE-R03, DMP.STORE-R07.
- **DMP.CICACHE-R04 Enforceable primitive:** Single-writer must be expressible
  as a callable primitive that fails closed when the designated publisher job is
  absent or when more than one job would save.
  Refines: DMP.STORE-R04.
- **DMP.CICACHE-R05 Publisher warms cold keys:** The single publisher must run
  on the normal push/PR flow that first warms a cold key and must install the
  fullest closure for that key, not only on restricted (scheduled/admitted)
  events.
  Refines: DMP.STORE-R09.

### Must key the cache stably

- **DMP.CICACHE-R06 Versioned per-repo key:** The cache key must be composed
  from a per-repo namespace prefix, a centralized cache version, and the
  `(os, arch, lockfile-hash)` identity, so a single version bump invalidates all
  consumers convergently and repo namespaces stay isolated.
  Refines: DMP-R09, DMP.STORE-R01.
- **DMP.CICACHE-R07 Exact-key restore:** Restore must use the exact composed key
  without loosening restore-key fallbacks that would serve a mismatched store.
  Refines: DMP-R15, DMP.STORE-R06.
