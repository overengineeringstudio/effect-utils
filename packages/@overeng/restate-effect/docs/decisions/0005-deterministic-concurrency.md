# Deterministic parallelism via explicit Restate.all/race (not raw Effect fibers)

Parallel durable operations must create their journal entries in a deterministic
(source) order or replay diverges. The binding provides explicit `Restate.all` /
`Restate.race` / `Restate.any` combinators that wrap the SDK's
`RestatePromise.all/race/any` for parallel durable calls and steps. Raw
`Effect.fork` and concurrent `Effect.all`/`Effect.race` over durable operations
inside a handler are unsafe and are lint-flagged/guarded. Sequential durable
operations (the common `Effect.gen` case) need no special handling.

## Why

- Restate journals each `ctx` op in issue order; nondeterministic fiber
  interleaving over durable ops produces nondeterministic journal order → RT0016
  on replay.
- Mirroring Restate's own parallel primitives keeps determinism explicit and
  robust, instead of betting correctness on Effect's (single-threaded but
  internal) fiber-scheduling order.

## Consequences

- Fan-out / scatter-gather goes through `Restate.all`/`race`/`any`, not
  `Effect.all` with concurrency.
- Pure (non-durable) concurrency in a handler is still allowed; only concurrency
  over durable ops is constrained.

Status: accepted
