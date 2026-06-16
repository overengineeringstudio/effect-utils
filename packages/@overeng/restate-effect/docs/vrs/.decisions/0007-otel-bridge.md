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

## Sibling to the shared `withTelemetry` foundation, not a convergence gap

The provider-registration layer above (`RestateOtel.layer`: a `NodeTracerProvider`
plus `provider.register()` plus a global `AsyncLocalStorageContextManager`) is a
DELIBERATE, structurally-required SIBLING of the shared telemetry foundation in
`@overeng/utils/node` (`withTelemetry` / `makeOtelCliLayer`, built on
`@effect/opentelemetry/Otlp.layerJson`). It is NOT an unfinished convergence
toward that foundation. The two are decoupled by construction and must stay so;
a future reader should not re-attempt to serve restate from the shared layer.

The proven global-registration requirement (above) is precisely WHY:

- **Global `@opentelemetry/api` registry dependency.** Restate's hook + inbound
  bridge + boundary observer read the active attempt span through the API GLOBAL
  (`trace.getActiveSpan()` / `trace.getTracer()`), so restate REQUIRES a globally
  registered SDK `TracerProvider` and a global context manager. The shared path
  is pure-Effect `Otlp.layerJson` — it builds its own Effect-native provider +
  exporter and POSTs OTLP itself, and DELIBERATELY never touches the global
  registry (no `@opentelemetry/sdk-*` peer deps; see
  `@overeng/utils/src/node/otel.ts`). The hook cannot read a provider the shared
  layer never registers globally.

- **Bolting an SDK provider onto the shared `service` shape is a double-export.**
  Adding a registered `NodeSdk`/`NodeTracerProvider` to the shared `service`
  layer would run TWO providers exporting the same spans → split / duplicated
  traces (the hook needs the hook AND Effect to share ONE provider so
  caller → `ingress_invoke` → `invoke` → `attempt` → Effect spans land in one
  trace). It would also drag `@opentelemetry/sdk-*` and a process-global
  `provider.register()` side effect onto EVERY CLI consumer of the shared layer.

What IS shared (and is the actual convergence surface): the naming LAW. Both
layers decode service identity through the `@overeng/otel-contract` brands
(`OtelServiceName` / `OtelServiceVersion`), so restate's resource obeys the same
naming law as the CLIs. Restate stamps `service.name` + `service.version` but NOT
`service.namespace`, so it decodes the individual brands at its resource edge
rather than the shared `ServiceIdentity` struct — that struct REQUIRES a
`namespace` (and a non-optional `version`), and inventing one for restate would
be a public-API change (`OtelResourceConfig` / `layerConfig`) deliberately not
made here.

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
