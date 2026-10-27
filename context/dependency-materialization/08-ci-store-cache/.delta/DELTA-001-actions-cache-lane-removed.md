# DELTA-001: Actions-cache lane deleted by the composition cutover

Status: open

## Divergence

This sub-area specifies a GitHub-Actions keyed save/restore lane for the CI
pnpm store/home/state (A02, DMP.CICACHE-R01–R07) with fail-closed
single-publisher write coordination. The buck2-branch CI has no such lane at
all: the generated `ci.yml` contains zero `actions/cache` steps, against 17
restore and 16 save steps on `main`.

The deleted lane was itself the divergence this delta records. The `main`
workflow's hand-rolled steps saved one key
(`pnpm-state-v2-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles(...) }}`)
from up to 16 jobs, each gated only on its own restore missing — a cold key
admitted many concurrent writers, violating DMP.CICACHE-R03 — and cached
workspace-relative `.pnpm-store`/`.pnpm-home` paths outside the specified
store layout, bypassing the `withSinglePnpmStatePublisher` stamper that
DMP.CICACHE-R04 requires. The violation was fixed by removal, not by adopting
the primitive: the composition cutover deleted the lane rather than
coordinating it.

## Intent

- [requirements.md](../requirements.md) A02 assumes a keyed save/restore
  cache backend; DMP.CICACHE-R03/R04 require exactly one fail-closed
  publisher per key; R05–R07 govern warming and key composition.
- [spec.md](../spec.md) specifies the workspace-relative store layout, the
  composed key, and the publisher gate/stamper primitives, and already names
  a persistent host-shared store as this lane's deferred evolution.

## Implementation

On this branch, `.github/workflows/ci.yml` persists no pnpm state through the
actions cache. Dependency content reaches jobs as Nix-prepared `*-pnpm-deps`
derivations resolved from the self-hosted runners' Nix store (with explicit
eviction steps for forced-cold validation), per
[../../03-nix-prepared-deps/](../../03-nix-prepared-deps/requirements.md).
The shared pnpm Actions-cache save/restore helpers, cache-key constants, and
publisher wrappers are removed. `pnpmStateSetupStep` remains exported to
initialize isolated job-local pnpm directories and environment; dependency
installation runs unconditionally without a restored Actions-cache snapshot.

## Direction

update Intent

## Resolution Signal

Re-scope this sub-area to match the cutover: record the Nix-store path as
this repo's CI-profile realization and retire the Actions-cache lane contract.
The delta closes when requirements.md and spec.md no longer present the
Actions-cache lane as load-bearing for this repo's or consumers' shared helpers.
