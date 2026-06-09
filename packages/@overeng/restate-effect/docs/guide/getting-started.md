# Getting started

[← Handbook index](./README.md)

## Install

```sh
pnpm add @overeng/restate-effect effect
```

`@restatedev/restate-sdk` and `@restatedev/restate-sdk-clients` come bundled. The
`./otel` subpath additionally needs `@effect/opentelemetry`, `@opentelemetry/api`,
`@opentelemetry/sdk-metrics` (the metrics path), and
`@restatedev/restate-sdk-opentelemetry` (peer deps you install when you use it). To
run an endpoint you also bring `@effect/platform-node` for `NodeRuntime.runMain`.
You need a `restate-server` binary to actually run handlers (via Restate's
CLI/Docker in production, or the [`./testing`](./testing.md) harness in tests).

## The mental model

Restate runs a single Rust binary (`restate-server`) in front of your handlers.
It owns the journal, durable state, deterministic replay, retries, and timers;
your handlers are plain functions it invokes over HTTP/2. This binding makes
those handlers Effect programs without dropping any of Restate's vocabulary.

```
   author time                                   run time
 ┌──────────────────────────┐         ┌───────────────────────────────────┐
 │ contract(name, schemas)  │         │  restate-server                   │
 │   ├─► typed ingress client         │  (journal · state · replay ·      │
 │   └─► in-handler clients │         │   retries · timers)               │
 │ implement(contract, eff) │         └────────────────┬──────────────────┘
 │   └─► endpoint Layer ─────┼──── h2c discovery+invoke │
 └──────────────────────────┘         ┌────────────────▼──────────────────┐
   AppLayer (clients, config) ───────►│ endpoint: per-invocation boundary │
   built once → Runtime<AppR>         │  decode → provide ctx + caps +    │
                                      │  determinism → run Effect →       │
                                      │  encode | toTerminal              │
                                      └───────────────────────────────────┘
```

**Two artifacts per construct:** a _contract_ (shareable, client-side, no server
deps) and an _implementation_ (the server-side Layer). The endpoint materializes
implementations against one shared application runtime and runs each invocation
through a single boundary that decodes the input, provides the per-invocation
context + capability markers + a journaled `Clock`/`Random`, runs your Effect, and
maps the outcome back to Restate.

The three constructs (covered in detail in [The three constructs](./constructs.md)):

| Construct      | Key             | State          | Concurrency                                     |
| -------------- | --------------- | -------------- | ----------------------------------------------- |
| Service        | none            | none           | unbounded                                       |
| Virtual Object | per key         | typed, durable | exclusive serialized per key; shared concurrent |
| Workflow       | per workflow ID | typed, durable | one `run` exactly-once; signals concurrent      |

## A first Service, end-to-end

A Service is stateless. You author a contract from Schemas, bind each handler to an
Effect, serve it, and call it through the typed ingress client. The full file is
[`examples/01-service.ts`](../../examples/01-service.ts).

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

// The implementation. `AppR` (`Greeting`) is passed EXPLICITLY — it is the residual
// requirement the application Layer satisfies. The `E` channel carries only `EmptyName`.
const GreeterLive = RestateService.implement<typeof Greeter, Greeting>(Greeter, {
  greet: ({ name }) =>
    Effect.gen(function* () {
      if (name === '') return yield* new EmptyName()
      const { prefix } = yield* Greeting
      // A UUID journaled once by `Restate.run`; a replay observes the same id.
      // `Restate.run`'s `E` is clean — no `.orDie` needed (an infra failure is a
      // defect at the boundary), so the handler `E` stays `EmptyName`-only.
      const id = yield* Restate.run(
        'gen-id',
        Effect.sync(() => crypto.randomUUID()),
      )
      return { message: `${prefix} ${name}`, id }
    }),
})
```

Serve it (a mixed `services` array can hold Services, Objects, and Workflows on one
endpoint), and call it. See [`examples/04-endpoint.ts`](../../examples/04-endpoint.ts)
and [`examples/06-ingress-client.ts`](../../examples/06-ingress-client.ts).

```ts
import { NodeRuntime } from '@effect/platform-node'
import { Effect } from 'effect'
import { callTyped, RestateIngress, serve } from '@overeng/restate-effect'

// The production entrypoint: SIGTERM → fiber interruption → finalizers (server
// close + every scoped application resource) in one atomic shutdown path.
serve({ services: [GreeterLive], port: 9080 }).pipe(
  Effect.provide(Greeting.Default), // the application Layer, built once
  NodeRuntime.runMain,
)

// A caller, anywhere:
const IngressLayer = RestateIngress.layer({ url: 'http://localhost:8080' })

const program = callTyped(Greeter, 'greet', { name: 'Sarah' }).pipe(
  Effect.map((ok) => ok.message), // : string  — validated typed success
  // The terminal error decodes back into the tagged `EmptyName` for `catchTag`:
  Effect.catchTag('EmptyName', () => Effect.succeed('(no name)')),
  Effect.provide(IngressLayer),
)
```

`serve(opts)` is `Layer.launch(layer(opts))`. For composing into a larger Layer
graph (or for tests), use `layer(opts)` directly — a scoped
`Layer<never, RestateError, AppR>`. See [The endpoint and serving](./endpoint.md).

## Three ports, never conflated

| Port             | Owner                 | Default | Role                                       |
| ---------------- | --------------------- | ------- | ------------------------------------------ |
| ingress          | `restate-server`      | 8080    | external entry point (callers → server)    |
| admin            | `restate-server`      | 9070    | health, deployment registration, State API |
| handler endpoint | this binding's server | 9080    | discovery + invoke (server → handlers)     |

The binding owns only the handler-endpoint port (the `port` you pass to `serve`).
Callers connect to the `restate-server` ingress port (8080), never to the handler
endpoint directly.

## Next steps

- Add typed State and keying → [The three constructs](./constructs.md).
- Understand the error channel → [Schema I/O and the typed error boundary](./schema-and-errors.md).
- Do side effects safely under replay → [Durable steps](./durable-steps.md) and [Determinism](./determinism.md).
- Test without Docker → [Testing](./testing.md).
