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
`Tracer.withSpanContext` is fed nothing → orphaned Effect spans. The binding
MUST therefore ensure the global is registered. `NodeSdk.layer` (`@0.63`)
registers a real `TracerProvider`; the spec verifies whether it also installs the
global context manager, and if not, the binding adds `Tracer.layerGlobal` /
`trace.setGlobalTracerProvider` + an `AsyncLocalStorageContextManager`. This is a
hard prerequisite, not a default to assume.

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

_Revised after design review: made the global `TracerProvider` + global context
manager registration an explicit prerequisite (otherwise `getActiveSpan()` is
`undefined` → orphaned spans); flagged `isReplaying` as version-fragile and made
`Restate.run` the preferred exactly-once seam._
