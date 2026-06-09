# `@overeng/restate-effect` — handbook

A task-oriented guide to using `@overeng/restate-effect`: a fully
Effect-idiomatic, type-safe binding to [Restate](https://restate.dev)'s
durable-execution engine. It exposes Restate's own model — Services, Virtual
Objects, Workflows, and the durable context primitives — as Effect-returning
combinators, layering Effect idioms (Schema I/O, tagged errors, Layers and
Scopes, OpenTelemetry) on top without hiding Restate.

This handbook covers the **stable v1 surface** end-to-end. It is a companion to,
not a replacement for, the design docs:

- The [`README`](../../README.md) is the npm-facing overview + quick start.
- This handbook is the practical, page-per-concern reference.
- [`docs/vrs/`](../vrs/) is the authoritative design model — [`vision.md`](../vrs/vision.md)
  (why), [`requirements.md`](../vrs/requirements.md) (what), [`spec.md`](../vrs/spec.md)
  (the architecture index over the ten subsystem specs), and
  [`.decisions/`](../vrs/.decisions/) (the hard-to-reverse calls).

## Every example is verified

Every code block in this handbook is drawn from a real, compiled-and-run example.
The example files live in [`examples/`](../../examples), are type-checked by
`dt ts:check`, and the runnable ones are driven against a native `restate-server`
by [`src/examples.integration.test.ts`](../../src/endpoint/examples.integration.test.ts)
and [`src/scheduled.integration.test.ts`](../../src/scheduling/scheduled.integration.test.ts)
under `dt check:all`. A snippet that stopped compiling or running would fail CI.
See [Verification](./verification.md) for the full story.

## Pages

| Page                                                              | What it covers                                                                                                                          |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [Getting started](./getting-started.md)                           | Install, the mental model, and a first Service end-to-end (contract → implement → endpoint → typed ingress call).                       |
| [The three constructs](./constructs.md)                           | Services, Virtual Objects (typed `State`, exclusive vs shared, `objectKey`), and Workflows (run + signals/queries, durable promises).   |
| [Authoring: contract, implement, define](./authoring.md)          | The two-artifact model, the typed clients (ingress + in-handler), calls/sends, and idempotency.                                         |
| [Schema I/O and the typed error boundary](./schema-and-errors.md) | The Schema↔Restate serde, slot-based decode classification, and how domain errors decode back into typed errors on the caller.          |
| [Durable steps, calls, and awakeables](./durable-steps.md)        | `Restate.run`/`runExit`, in-handler clients, idempotency, and awakeables (create + `descriptor` + ingress resolve).                     |
| [Determinism](./determinism.md)                                   | Journaled Clock/Random, explicit `Restate.sleep`/`timeout`/`race`, descriptors, and the durability lints.                               |
| [Annotations and redaction](./annotations.md)                     | `terminal`/`retryable` + `retryAfter`, `retention`, and field-level redaction (`sensitive`/`redacted`).                                 |
| [The endpoint and serving](./endpoint.md)                         | The endpoint as a scoped Layer, `serve` + graceful shutdown, and the daemon latency teaching.                                           |
| [Self-reschedule and durable scheduling](./scheduling.md)         | `Restate.reschedule` + `RestateScheduled`/`pollLoop`. (Composition example pending a refinement.)                                       |
| [Cancellation and lifecycle](./cancellation.md)                   | Cancel ↔ interruption, finalizers/compensations, and graceful shutdown.                                                                 |
| [OpenTelemetry (`./otel`)](./observability.md)                    | `RestateOtel.layer` (traces + metrics), span attributes, `Restate.annotateSpan`, and the replay-aware metrics.                          |
| [Operations (`./admin`)](./admin-operations.md)                   | The `RestateAdmin` management surface (cancel/kill/restart, deployments, SQL introspection) + the Molty operating-a-deployment runbook. |
| [Testing (`./testing`)](./testing.md)                             | The in-memory `TestContext`, the native-server harness, live-clock utils, and the unit/contract/integration layering.                   |
| [API reference](./api-reference.md)                               | The public surface from `mod.ts` + `./otel` + `./testing`.                                                                              |
| [Verification + migration notes](./verification.md)               | How examples are verified, what is stable vs deferred, and migration notes.                                                             |

## When to use this binding

This is a **faithful binding**, not a vendor-neutral facade: Restate is the
programming model and the engine. If you want Effect's own durable engine, use
`@effect/workflow` + `@effect/cluster` instead. See [`vision.md`](../vrs/vision.md)
for the full motivation.
