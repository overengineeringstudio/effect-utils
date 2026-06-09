# Requirements: 03-effect-runtime

**Role.** The Effect-idiom layer the per-invocation boundary installs: journaled
`Clock`/`Random`, explicit durable waits, deterministic durable concurrency, the
nondeterminism/durability lints, and the replay-aware logger that routes
`Effect.log*` into `ctx.console`. Makes idiomatic Effect code replay-safe by
construction.

Builds on the cross-cutting [../requirements.md](../requirements.md) (global
A/T) and [../glossary.md](../glossary.md). IDs are GLOBAL and preserved.

## Requirements

### Must guarantee determinism

- **R17 Journaled time and randomness:** Inside a handler runtime,
  `Clock.currentTimeMillis` MUST read journaled time (`ctx.date`) and `Random`
  MUST read journaled, seeded randomness (`ctx.rand`). The SYNC
  `Clock.unsafeCurrentTimeMillis` / `unsafeCurrentTimeNanos` (which cannot be
  backed by the async `ctx.date`) MUST be served from a per-attempt frozen
  monotonic base seeded once at handler entry, so wall-clock reads are replay-safe
  and do not advance mid-attempt. (A04; [../.decisions/0004](../.decisions/0004-determinism-layer.md).)
- **R18 Explicit durable waits:** Durable waits MUST be explicit combinators —
  `Restate.sleep`, `Restate.timeout`, `Restate.race` — backed by `ctx.sleep` /
  `RestatePromise.orTimeout`. The binding MUST NOT transparently remap
  `Clock.sleep` to `ctx.sleep`; a bare in-handler `Effect.sleep` stays
  non-durable. (A04, T02; [../.decisions/0004](../.decisions/0004-determinism-layer.md).)
- **R19 Deterministic durable concurrency:** Concurrency over durable operations
  MUST go through `Restate.all` / `race` / `any`, which take durable-op
  descriptors, issue them in source order to obtain the `RestatePromise[]`, and
  hand those to the SDK's `RestatePromise.all/race/any` (preserving journal
  order); each `RestatePromise` MUST be awaited exactly once and transformed only
  after awaiting (never `.then`-chained). Raw fiber concurrency over durable
  operations MUST be guarded/lint-flagged. Sequential durable operations and pure
  in-handler concurrency need no special handling. (A04, T04; [../.decisions/0005](../.decisions/0005-deterministic-concurrency.md).)
- **R20 Nondeterminism lint:** A lint rule MUST flag raw nondeterminism in
  handler bodies (`Date.now()`, `new Date()`, `Math.random()`,
  `crypto.randomUUID()`, and un-journaled I/O) OUTSIDE `Restate.run` and the
  journaled Clock/Random, as an advisory backstop to the determinism layer.
  `crypto.randomUUID()` strictly inside a `Restate.run` closure is exempt (where
  the journaled `Random` is unavailable). (A04; [../.decisions/0004](../.decisions/0004-determinism-layer.md).)

### Must produce coherent, replay-correct observability

- **R37 Replay-aware in-handler logging:** An in-handler `Effect.log*` MUST route
  to the invocation's replay-aware `ctx.console` (suppressed during replay,
  level-controlled via `RESTATE_LOGGING`, stamped with invocation context), so a
  log is NOT re-emitted on every replay/attempt. This is on the CORE `.` export
  (no `./otel`), provided per invocation alongside the determinism layer. A log
  line is non-durable (never journaled); side-effecting telemetry MUST instead go
  through `Restate.run`. ([../.decisions/0015](../.decisions/0015-logger-ctx-console-bridge.md).)
