# Deterministic GC test contract

## Status

accepted

## Context

Cold-worktree reclamation is safety-critical and depends on time, network state,
and git state. Tests need deterministic seams for those inputs while keeping the
actual policy and filesystem behavior real.

## Decision

Two boundaries are injected:

- time: explicit `now` epoch milliseconds is threaded through classification,
  observations, archive, and registry refresh
- PR state: `PrStateResolver` is an Effect service; production shells to `gh`,
  tests provide a deterministic layer

Coverage is layered cheapest-first:

- pure unit tests for gate precedence, PR parsing, config merge, and ledger
  transitions
- property tests for invariants such as live/open/none/locked worktrees keeping
- integration tests with real git fixtures for cross-megarepo liveness, archive,
  reap, and re-materialization
- gated real-binary tests against isolated stores

Vitest pins git globals, author identity, and fixture realpaths so CI and macOS
host defaults cannot change results.

## Consequences

- Safety claims are expressed as regression tests, not just policy prose.
- Dry-run and real-run behavior are tested separately because only real runs may
  mutate observation state.
