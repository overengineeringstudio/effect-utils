# Deterministic Clock / Random / sleep layer + nondeterminism lint

Inside the per-invocation handler runtime, the binding auto-provides:

- `Clock` backed by `ctx.date` (journaled time reads),
- `Random` backed by `ctx.rand` (seeded, journaled),
- `Clock.sleep` remapped to `ctx.sleep` (durable timer), so plain `Effect.sleep` /
  `Effect.timeout` become Restate-durable transparently.

It also ships an oxlint rule banning raw nondeterminism in handler bodies:
`Date.now()`, `new Date()`, `Math.random()`, `crypto.randomUUID()`, and
un-journaled I/O outside `ctx.run`.

## Why

- Restate's deterministic-replay contract is load-bearing; Effect's default
  `Clock`/`Random`/scheduler read real time / PRNG / in-memory and silently break
  replay (RT0016). Backing them with `ctx` makes handlers correct-by-construction
  rather than correct-if-the-author-remembers.
- The `Clock.sleep`→`ctx.sleep` remap turns Effect's idiomatic time combinators
  into durable waits — exactly what the workflow scenarios need.

## Consequences

- Every `Effect.sleep` / `Effect.timeout` in a handler becomes a journaled durable
  timer (a feature for long waits, possible overhead for tight internal sleeps).
  An explicit non-durable escape hatch may be provided if validation shows it's
  needed.
- The lint rule is advisory backup; the layer is the primary guarantee.

Status: accepted
