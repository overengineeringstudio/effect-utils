# Logger → `ctx.console` replay-aware bridge

The determinism layer ([decision 0004](./0004-determinism-layer.md)) journals an
Effect `Clock` and `Random` per invocation, but NOTHING bridged Effect's `Logger`.
So an in-handler `Effect.log*` ran on Effect's DEFAULT logger, which writes to
`globalThis.console` — a NON-replay-aware sink. An invocation re-runs its handler
on every attempt and replays journaled work, so a single `Effect.logInfo` re-emitted
the line on EVERY replay/attempt: noisy, misleading logs (the same event printed
many times), and no per-invocation context. This decision adds a per-invocation
`Logger`, exactly parallel to the determinism layer.

## What

A per-invocation `loggerLayer(ctx)` — `Logger.replace(Logger.defaultLogger, …)` —
provided over every handler effect ALONGSIDE `determinismLayer`, in every
`materialize*` path. The replacement logger routes each Effect log record into the
invocation's `ctx.console`:

```
Logger.make(({ logLevel, message, annotations, spans, … }) =>
  ctx.console[consoleMethodFor(logLevel)](logfmtLogger.log(options)))
```

- **Sink = `ctx.console`.** The SDK's `ctx.console` is a standard `Console` that
  (a) AUTOMATICALLY suppresses output during replay, (b) stamps each line with the
  invoked service/handler + invocation id, and (c) honors the `RESTATE_LOGGING`
  level. By routing through it we get replay-suppression + level control + context
  for free — only the SINK changes, not the format.
- **Format = Effect's own `logfmt`.** `Logger.logfmtLogger` (a
  `Logger<unknown, string>`) produces the line, so annotations (`Effect.annotateLogs`),
  spans, fiber id, and cause ride along exactly as Effect's default console output
  does. We reuse Effect's formatter rather than reinventing one.
- **Level map.** `consoleMethodFor` maps the Effect `LogLevel` to the `Console`
  method: `Trace`/`Debug` → `debug`, `Info`/`All` → `info`, `Warning` → `warn`,
  `Error`/`Fatal` → `error`.
- **Synchronous.** `ctx.console` is sync, so the logger composes cleanly as a
  `Logger.replace` — no async indirection.

## Why this shape

- **Parallel to `determinismLayer`.** The same per-invocation seam the journaled
  Clock/Random already occupies — provided at `materialize*`, never in the long-lived
  application Layer. Replay-correctness for logs is the same class of concern as
  replay-correctness for time/randomness.
- **Reuse the SDK's replay knowledge.** `ctx.console` already owns the non-replay
  gate the OTel path also rides ([decision 0014](./0014-observability-metrics-and-attrs.md)).
  Bridging into it is strictly better than re-implementing replay suppression in the
  logger.
- **Reuse Effect's formatter.** Piping `logfmtLogger.log(options)` into `ctx.console`
  keeps the format consistent with the rest of the Effect ecosystem and avoids a
  bespoke serializer.

## Boundaries

- A log line is NOT a durable side effect. It is suppressed on replay but never
  journaled. For side-effecting telemetry (an external sink write, a business
  counter), route it through `Restate.run` — the same exactly-once seam the metrics
  path uses (decision 0014).
- The endpoint's OWN startup log (`"… endpoint listening on …"`, `Endpoint.ts`) runs
  OUTSIDE any handler, so it keeps the process default logger — `loggerLayer` is
  provided per invocation, not endpoint-wide, so startup logging is unaffected.

## Consequences

- `loggerLayer` is exported from the core (`mod.ts`) for direct testing, wired by
  every `materialize*` path via `Layer.merge(determinismLayer(…), loggerLayer(ctx))`.
- Verified server-free (`src/Runtime.test.ts`): an in-handler `Effect.log*` routes
  to the matching `ctx.console` method, and a replayed attempt (modeled by a console
  that drops calls while replaying) does NOT double-emit.

Status: accepted
