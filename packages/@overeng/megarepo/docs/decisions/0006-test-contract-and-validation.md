# Deterministic GC test contract

## Status

accepted

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
