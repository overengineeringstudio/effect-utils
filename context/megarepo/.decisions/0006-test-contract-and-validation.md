# Deterministic GC test contract

Status: accepted

Migrated from `packages/@overeng/megarepo/docs/decisions` on 2026-08-31. The
Decision section is verbatim; the `Status:` line and the Context / Evidence and
Argument / Options sections were added to satisfy the VRS decision-record
shape, from this record's own material.

## Context

Every gate in decision [0001](./0001-reclaim-cold-worktrees-in-default-gc.md)
depends on something the host supplies: wall-clock time for the grace timers,
and GitHub PR state for staleness. Without a deliberate injection boundary those
gates are untestable, and a safety regression would only show up as lost work on
a real store.

## Evidence and Argument

The boundaries chosen are the minimum set that makes classification
reproducible: time and PR state. Everything else — git, the filesystem, the
store layout — is exercised for real, because a test that mocks them stops
testing the thing that can lose work. Host variation is neutralized by pinning
git defaults, author identity, and fixture realpaths rather than by abstracting
git away, and macOS path behavior in particular must not be able to change a
safety result.

## Options

This record predates the current decision-record shape and did not enumerate
options. The table below is reconstructed from alternatives implied by the
record's own framing.

| Option                                                | Tradeoff                                                                   | Outcome  |
| ----------------------------------------------------- | -------------------------------------------------------------------------- | -------- |
| Inject only `now` and `PrStateResolver` (this record) | Deterministic gates over real git and a real store; two seams to maintain  | Accepted |
| Mock git, filesystem, and store as well               | Fast and fully deterministic; stops testing the layer that can lose work   | Rejected |
| Let tests reach the real `gh` and wall clock          | No seams at all; results depend on network, host identity, and time of run | Rejected |

## Decision

GC tests inject only the non-deterministic boundaries:

- `now` epoch milliseconds for classification, observations, archive, and
  registry refresh
- `PrStateResolver` as an Effect service; production shells to `gh`, tests stub it

Coverage layers: pure gate/ledger/config tests, property tests for keep
invariants, real-git integration fixtures for liveness/archive/reap/re-apply, and
gated real-binary tests against isolated stores.

Vitest pins git defaults, author identity, and fixture realpaths so host git and
macOS path behavior cannot change safety results.
