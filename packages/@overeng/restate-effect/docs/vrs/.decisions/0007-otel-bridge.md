# Full OpenTelemetry bridge in v1 (behind ./otel subpath)

OTel is a first-class v1 feature. The binding wires Restate's
`@restatedev/restate-sdk-opentelemetry` `openTelemetryHook` on every service and
shares a single OTel `TracerProvider` with Effect (`@effect/opentelemetry`
`NodeSdk.layer`). At handler entry it bridges the hook's attempt span into Effect
as the parent (inbound `Tracer.withSpanContext`), so caller → `ingress_invoke` →
`invoke` → `attempt` → Effect spans form one coherent trace. Custom span events /
metric increments are gated so replay does not double-emit; `ctx.run` spans are
owned by the hook (fire once on real execution). `Effect.withSpan` stays on
boundary ops.

The inbound bridge depends on a registered GLOBAL `TracerProvider` AND a global
context manager (`AsyncLocalStorageContextManager` / AsyncHooks), so the hook's
`trace.getActiveSpan()` resolves the attempt span at handler entry. Without the
global context manager, `getActiveSpan()` returns `undefined` and
`Tracer.withSpanContext` is fed nothing → orphaned Effect spans.

This is a PROVEN-required step, not an assumption. Empirically (`@effect/opentelemetry`
`@0.63`): `NodeSdk.layer` registers NEITHER a global `TracerProvider` NOR a global
context manager (`getActiveSpan()` stays `undefined` until something registers them),
and `Tracer.layerGlobal` only reads/sets the provider — it installs NO context
manager, so it is INSUFFICIENT on its own. The `./otel` binding MUST therefore
itself either call `provider.register()` (which installs both the global provider
AND a default `AsyncLocalStorageContextManager`) OR
`trace.setGlobalTracerProvider(provider)` + `context.setGlobalContextManager(new
AsyncLocalStorageContextManager().enable())`. A hard prerequisite the binding owns.

`isReplaying` is sourced from an UNSTABLE internal SDK symbol
(`Symbol.for("@restatedev/restate-sdk/hooks.isProcessing")`) and is version-fragile.
PREFER routing exactly-once telemetry through `Restate.run` closures (which run
once on real execution and are skipped on replay) over gating on the
`isReplaying` flag. `isReplaying` is still exposed for user code, but the
load-bearing exactly-once mechanism is `Restate.run`, not the flag.

This lives behind an `./otel` subpath export so `@effect/opentelemetry` +
`@restatedev/restate-sdk-opentelemetry` are opt-in (the core stays dep-light).

## Why

- "Proper OTel support" is a headline requirement; disconnected server/handler
  traces and replay double-counting would undermine it. The bridge recipe is
  concrete and replay-aware.

## Consequences

- The hook owns attempt/run spans + replay suppression; the Effect layer must not
  re-emit them.
- An `isReplaying` capability is exposed (also useful to user code) to gate
  side-effecting telemetry — but it reads an unstable internal symbol, so
  `Restate.run` is the preferred exactly-once seam.

Status: accepted

_Revised: the global-registration requirement (proven above) and the
`isReplaying`-is-fragile / `Restate.run`-is-the-exactly-once-seam guidance were
both folded into the body._
