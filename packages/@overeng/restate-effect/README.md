# @overeng/restate-effect

A fully Effect-idiomatic, type-safe binding to [Restate](https://restate.dev)'s
durable-execution engine. It exposes Restate's own model — Services, Virtual
Objects, Workflows, and the durable context primitives — as Effect-returning
combinators, layering Effect idioms (Schema I/O, tagged errors, Layers and Scopes,
OpenTelemetry) on top without hiding Restate.

This is a faithful binding, not a vendor-neutral facade: Restate is the programming
model and the engine. If you want Effect's own durable engine, use
`@effect/workflow` + `@effect/cluster` instead.

## Status

The stable v1 surface — Services, Virtual Objects, Workflows, the Schema serde +
typed error boundary, determinism, durable steps/calls/awakeables, cancellation, the
endpoint, `./otel`, and `./testing` — is implemented and verified end-to-end against
a real native `restate-server`. Every code snippet in the docs is a real,
compiled-and-run example (see [Documentation](#documentation)).

## Install

```sh
pnpm add @overeng/restate-effect effect
```

`@restatedev/restate-sdk` and `@restatedev/restate-sdk-clients` come bundled. The
`./otel` subpath additionally needs `@effect/opentelemetry`, `@opentelemetry/api`,
`@opentelemetry/sdk-metrics`, and `@restatedev/restate-sdk-opentelemetry` (peer deps
you install when you use it). To run an endpoint you also bring
`@effect/platform-node` for `NodeRuntime.runMain`. You need a `restate-server` binary
to run handlers (Restate's CLI/Docker in production, or the `./testing` harness in
tests).

## Quick start

A Service is stateless: author a contract from Schemas, bind each handler to an
Effect, serve it, and call it through the typed ingress client. The full file is
[`examples/01-service.ts`](./examples/01-service.ts).

```ts
import { Context, Effect, Layer, Schema } from 'effect'
import { Restate, RestateService } from '@overeng/restate-effect'

class Greeting extends Context.Tag('example/Greeting')<Greeting, { readonly prefix: string }>() {
  static readonly Default = Layer.succeed(Greeting, { prefix: 'Hello' })
}

const GreetInput = Schema.Struct({ name: Schema.String })
const GreetSuccess = Schema.Struct({ message: Schema.String, id: Schema.String })

// A declared business error: it crosses the wire as a terminal error and decodes
// back into THIS tagged error on the caller side.
class EmptyName extends Schema.TaggedError<EmptyName>('example/EmptyName')('EmptyName', {}) {}

// The contract: handler names + their I/O/error Schemas. Shareable; no server deps.
const Greeter = RestateService.contract('greeter', {
  greet: { input: GreetInput, success: GreetSuccess, error: EmptyName },
})

// The implementation. `AppR` (`Greeting`) is passed EXPLICITLY — the residual
// requirement the application Layer satisfies. The `E` channel carries only `EmptyName`.
const GreeterLive = RestateService.implement<typeof Greeter, Greeting>(Greeter, {
  greet: ({ name }) =>
    Effect.gen(function* () {
      if (name === '') return yield* new EmptyName()
      const { prefix } = yield* Greeting
      // A UUID journaled once by `Restate.run`; a replay observes the same id.
      const id = yield* Restate.run(
        'gen-id',
        Effect.sync(() => crypto.randomUUID()),
      )
      return { message: `${prefix} ${name}`, id }
    }),
})
```

Serve it and call it (see [`examples/04-endpoint.ts`](./examples/04-endpoint.ts) and
[`examples/06-ingress-client.ts`](./examples/06-ingress-client.ts)):

```ts
import { NodeRuntime } from '@effect/platform-node'
import { Effect } from 'effect'
import { callTyped, RestateIngress, serve } from '@overeng/restate-effect'

serve({ services: [GreeterLive], port: 9080 }).pipe(
  Effect.provide(Greeting.Default), // the application Layer, built once
  NodeRuntime.runMain, // SIGTERM → fiber interruption → graceful shutdown
)

// A caller, anywhere:
const program = callTyped(Greeter, 'greet', { name: 'Sarah' }).pipe(
  Effect.map((ok) => ok.message), // : string — validated typed success
  Effect.catchTag('EmptyName', () => Effect.succeed('(no name)')), // typed error decode
  Effect.provide(RestateIngress.layer({ url: 'http://localhost:8080' })),
)
```

## What you get

- **Three constructs** — Service, keyed Virtual Object (typed durable State,
  exclusive vs shared handlers), and Workflow (one exactly-once `run` + signals /
  queries coordinated through durable promises).
- **A typed error boundary** — declared domain errors cross the wire as terminal
  errors and decode back into the original tagged error for `catchTag`; the binding's
  own infra failures are defects, never in your domain channel.
- **Determinism by construction** — journaled `Clock` / `Random`, durable steps via
  `Restate.run`, explicit durable waits (`Restate.sleep` / `timeout` / `race`), and
  oxlint backstops.
- **Durable calls, sends, and awakeables** — typed in-handler and ingress clients,
  idempotency from an annotated input field, external-completion tokens.
- **Operability** — an opt-in `./otel` bridge (one coherent trace + replay-aware
  metrics + identity span attributes), field-level redaction, and cancellation ↔
  Effect interruption with finalizers.
- **Docker-free testing** — a native-server harness plus a faithful in-memory
  `TestContext` for server-free handler-logic tests.

## Documentation

The **[handbook in `docs/guide/`](./docs/guide/README.md)** is the real reference — a
page-per-concern guide where every code block is a verified example:

- [Getting started](./docs/guide/getting-started.md) — install, the mental model, a first Service.
- [The three constructs](./docs/guide/constructs.md) — Services, Virtual Objects, Workflows.
- [Authoring](./docs/guide/authoring.md) — `contract`/`implement`/`define` + the typed clients.
- [Schema I/O and the typed error boundary](./docs/guide/schema-and-errors.md).
- [Durable steps, calls, and awakeables](./docs/guide/durable-steps.md).
- [Determinism](./docs/guide/determinism.md), [Annotations and redaction](./docs/guide/annotations.md).
- [The endpoint](./docs/guide/endpoint.md), [Cancellation](./docs/guide/cancellation.md), [Self-reschedule](./docs/guide/scheduling.md).
- [OpenTelemetry](./docs/guide/observability.md), [Testing](./docs/guide/testing.md), [API reference](./docs/guide/api-reference.md).

The [`examples/`](./examples) are type-checked by `dt ts:check` and driven against a
native `restate-server` by `src/examples.integration.test.ts` (under `dt check:all`),
so a documented snippet that stopped working would fail CI.

Design docs live under [`docs/vrs/`](./docs/vrs): [vision.md](./docs/vrs/vision.md)
(why), [spec.md](./docs/vrs/spec.md) (the architecture index, linking the ten
subsystem specs), [.decisions/](./docs/vrs/.decisions) (the hard-to-reverse calls),
and [glossary.md](./docs/vrs/glossary.md) (Restate + binding vocabulary).
