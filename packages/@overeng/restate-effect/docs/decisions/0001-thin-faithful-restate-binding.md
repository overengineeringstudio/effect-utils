# Thin, faithful Effect binding to Restate (not a pluggable durable-execution facade)

`@overeng/restate-effect` exposes Restate's own model and vocabulary directly —
Services, Virtual Objects, Workflows, and the durable context primitives
(`ctx.run`, `ctx.sleep`, awakeables, durable promises, keyed K/V state,
service-to-service calls) — each as an Effect-returning combinator. It layers
Effect *idioms* on top (Schema-based I/O + error boundary, Layers/Scopes for
lifecycle, tagged errors, observability spans) but never hides Restate. Restate
is the programming model and the durable-execution engine.

We deliberately do NOT build a vendor-neutral durable-execution abstraction over
a pluggable engine, and we do NOT depend on or mirror `@effect/cluster` /
`@effect/workflow` as the engine.

## Why

- Restate's journaling/replay/virtual-object model is the entire value
  proposition; abstracting it behind a generic facade fights its grain and
  forfeits its strengths (mechanical sympathy).
- Effect already ships `@effect/workflow` + `@effect/cluster` for those who want
  Effect's *own* durable engine. A second, lower-fidelity abstraction over
  Restate would be confusing overlap.
- A faithful binding stays trivially current with Restate and lets users lean on
  Restate's own docs, CLI, and UI.

## Consequences

- Handler code is coupled to Restate's model; there is no engine portability.
  This coupling is intentional.
- "Fully Effect-idiomatic" is achieved through *how* the surface is exposed
  (Schema, Layer, tagged errors, spans), not by hiding Restate.
- Vocabulary stays Restate-native (`run`, `awakeable`, `objectClient`, …); we may
  borrow an individual clearer name from `@effect/workflow` only where it
  strictly improves clarity (a separate, minor decision).

Status: accepted
