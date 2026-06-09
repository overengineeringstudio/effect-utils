# The endpoint and serving

[← Handbook index](./README.md)

The endpoint is a scoped `Layer`. It captures the application runtime once,
materializes each implementation against it, starts an HTTP/2 (h2c) server the
`restate-server` discovers and invokes, and closes it on scope teardown — so it
participates in graceful shutdown. The full file is
[`examples/04-endpoint.ts`](../../examples/04-endpoint.ts).

## Two surfaces: `layer` and `serve`

- **`layer(opts)`** — the scoped `Layer<never, RestateError | ConfigError, AppR>`.
  Compose it like any Layer; provide the application Layer (`AppR`) to discharge
  handler requirements. The `ConfigError` arm only fails when `port` is a
  `Config<number>` the environment does not satisfy (a literal-`number` port never
  produces one). Use this when composing into a larger Layer graph, or in tests.
- **`serve(opts)`** — `Layer.launch(layer(opts))`: a long-lived `Effect` that blocks
  until interrupted, running finalizers (server close + every scoped application
  resource) on SIGTERM. This is the production entrypoint.

```ts
import { NodeRuntime } from '@effect/platform-node'
import { Effect } from 'effect'
import { serve } from '@overeng/restate-effect'

serve({ services: [GreeterLive], port: 9080 }).pipe(
  Effect.provide(Greeting.Default), // the application Layer, built once
  NodeRuntime.runMain, // SIGTERM → Fiber.interrupt → finalizers
)
```

`@effect/platform-node`'s `NodeRuntime.runMain` maps SIGTERM → fiber interruption →
finalizers. It is the consumer's dependency (the binding keeps platform deps off its
own surface), so the example file demonstrates the platform-free scoped form the
integration tests use.

## One endpoint, one `AppR`

One endpoint captures **one** application runtime, so every construct it serves
shares the same `AppR`. A construct's `AppR` is the explicit type param to
`implement` (`never` when it needs no application service).

- Mixing constructs that share an `AppR` is fine (a Service + an Object + a Workflow
  on one endpoint).
- To serve constructs with **different** `AppR` on one endpoint, declare each at the
  endpoint's full `AppR` (the union of every construct's requirements) when you
  implement it.

```ts
import { type EndpointOptions } from '@overeng/restate-effect'

// A mixed endpoint of constructs that share `AppR = never` (an Object + a Workflow).
export const mixedEndpointOptions: EndpointOptions<never> = {
  services: [CounterLive, ApprovalLive],
  port: 9081,
}
```

## Graceful shutdown

Under `serve` + `NodeRuntime.runMain`, SIGTERM interrupts the fiber, closing the
HTTP/2 server and running every scoped application finalizer in **one atomic
shutdown path** — in the same scope. An in-flight handler is interrupted at its next
durable await point (see [Cancellation](./cancellation.md)), its finalizers run, and
the server closes.

The endpoint serves h2c (HTTP/2 cleartext, prior-knowledge); the binding owns the
`http2.Http2Server` inside `Effect.acquireRelease` to provide the close that the SDK
itself exposes no hook for.

## The three ports

| Port             | Owner                 | Default | Role                                       |
| ---------------- | --------------------- | ------- | ------------------------------------------ |
| ingress          | `restate-server`      | 8080    | external entry point (callers → server)    |
| admin            | `restate-server`      | 9070    | health, deployment registration, State API |
| handler endpoint | this binding's server | 9080    | discovery + invoke (server → handlers)     |

The binding owns only the handler-endpoint port (the `port` you pass to `serve`).
8080/9070 belong to `restate-server`; callers connect to 8080, never to the handler
endpoint directly. (The testing harness uses OS port-0 for all three — see
[Testing](./testing.md).)

## Configuration from the environment

Three surfaces read configuration from `Config` so a deployment can wire them from
the environment without threading values by hand:

- **Port.** `port` accepts a literal `number` **or** a `Config<number>` (e.g.
  `Config.integer('PORT')`), resolved on layer acquisition. A `Config` the
  environment does not satisfy fails the layer with a `ConfigError`.
- **Ingress client.** `RestateIngress.layerConfig()` reads the ingress URL from
  `RESTATE_INGRESS_URL` and an **optional** API key from `RESTATE_INGRESS_KEY` (a
  `Config.redacted`, so the secret stays a `Redacted` and never prints).
- **OTel.** `RestateOtel.layerConfig` reads `OTEL_SERVICE_NAME` /
  `OTEL_EXPORTER_OTLP_ENDPOINT` (see [Observability](./observability.md)).

```ts
import { Config } from 'effect'

serve({ services: [GreeterLive], port: Config.integer('PORT') }).pipe(/* … */)
```

## Securing the endpoint

By default the handler-endpoint port (9080) is **unauthenticated** — anything that
can reach it can invoke a handler. Two independent surfaces close that hole for a
secured / Restate Cloud deployment:

- **Request identity (server → handlers).** Pass `identityKeys` — ED25519 public
  keys in the SDK's `publickeyv1_…` format — to `serve` / `layer`. The SDK then
  rejects any inbound request not signed by the matching private key (the
  `x-restate-signature-scheme: v1` + `x-restate-jwt-v1` JWT check), so only your
  Restate cluster can invoke the endpoint. Pure passthrough — the SDK owns the
  verification. Leave it unset on a trusted local network.

  ```ts
  serve({
    services: [GreeterLive],
    port: Config.integer('PORT'),
    identityKeys: ['publickeyv1_2G8dCQhArfvGpzPw5Vx2ALciR4xCLHfS5YaT93XjNxX9'],
  })
  ```

- **Ingress auth (you → server).** A secured ingress (Restate Cloud) needs a bearer
  API key on every ingress request. `RestateIngress.layer({ url, apiKey })` (or the
  env-driven `RestateIngress.layerConfig()`) sends it as `Authorization: Bearer …`.
  The `apiKey` is a `Redacted<string>`, so it never prints in logs or errors.

  ```ts
  import { Config, Redacted } from 'effect'

  // literal: apiKey as a Redacted (never printed)
  RestateIngress.layer({ url: 'https://…/ingress', apiKey: Redacted.make(key) })

  // env-driven: RESTATE_INGRESS_URL + (optional) RESTATE_INGRESS_KEY
  RestateIngress.layerConfig()
  ```

## The daemon latency teaching

A durable daemon — a poller or watcher that wakes periodically — uses a one-way
`send` + a delayed self-send, **never** a blocking `call`. A blocking ingress `call`
into a per-key Virtual Object serializes behind that key's write lock and stacks on
top of the platform's retry backoff; under load this was measured at an 18.4s p99.
The self-send shape returns immediately after enqueuing the next cycle. This is
covered in full in [Self-reschedule and durable scheduling](./scheduling.md).

## See also

- [Cancellation and lifecycle](./cancellation.md) — interruption + the shutdown path.
- [Observability](./observability.md) — wrapping the endpoint with the OTel bridge.
- [Testing](./testing.md) — the native-server harness wraps the endpoint for you.
