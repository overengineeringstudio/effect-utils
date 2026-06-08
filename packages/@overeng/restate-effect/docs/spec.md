# Spec: restate-effect

This document specifies how `@overeng/restate-effect` realizes its constraints.
It builds on [requirements.md](./requirements.md). Terms are in
[glossary.md](./glossary.md); the hard-to-reverse rationale is in
[decisions/](./decisions/), cited by relative path. Rationale is not repeated
inline.

## Status

Draft. The POC (commit `61c8d8cf`) proved the core pillars — Schema serde,
per-invocation runtime boundary, durable `ctx.run`/`ctx.sleep`, the endpoint
scoped Layer, and tagged-error → `TerminalError` mapping — using a combined
`RestateService.make`. This spec describes the TARGET design, in which decision
[0010](./decisions/0010-separated-contract-impl.md) supersedes the combined
`make` with separated `contract` + `implement`. Sections note where the POC
differs.

## Scope

Defines: the contract/implement authoring API for all three constructs; the
per-invocation Effect runtime boundary; the typed capability-marker context
model; the Schema↔Restate serde; the error boundary and typed ingress decode;
the determinism layer and lint; deterministic concurrency combinators; retry
surfacing; the endpoint Layer and `serve`; the ingress and in-handler typed
clients; the OTel bridge; and the testing harness.

Does not define: the Restate engine semantics themselves (see
[glossary.md](./glossary.md) and Restate's own docs); the deferred features
listed under [Deferred](#deferred-designed-for-later).

## Architecture

```
                         author time                           run time
  ┌───────────────────────────────────────┐     ┌──────────────────────────────────┐
  │ contract(name, { handler: {            │     │  restate-server (Journal, State, │
  │   input, success, error, state? } })   │     │  Replay, retries, timers)        │
  │            │                           │     └───────────────┬──────────────────┘
  │            ├──► typed ingress client   │          h2c protocol│ (discovery + invoke)
  │            └──► in-handler clients      │                     ▼
  │ implement(contract, { handler: eff })  │     ┌──────────────────────────────────┐
  │            │                           │     │ endpoint Layer (scoped h2c serve)│
  │            ▼                           │     │   materialize(impl, runtime)     │
  │     server-side Layer ─────────────────┼────►│     per-invocation boundary:     │
  └───────────────────────────────────────┘     │       decode → provide ctx +     │
                                                 │       capability markers + det.  │
   shared AppLayer (clients, config) ───────────►│       layer → run Effect →       │
   built once → Runtime<R>                       │       encode | toTerminal        │
                                                 └──────────────────────────────────┘
```

Two artifacts per service: a **contract** (shareable, client-side, no server
deps; satisfies R09) and an **implementation** (server-side Layer). The endpoint
materializes implementations against a shared runtime and runs each invocation
through one boundary (R30).

Module layout (subpath exports):

```
.            core: constructs, combinators, serde, error boundary, endpoint, clients
./otel       OpenTelemetry bridge (opt-in deps)          (R03, R23–R25)
./testing    Docker-free native-server harness Layer     (R26–R28)
```

---

## 1. Authoring API: contract and implement

Traces: R07, R09, R10. See
[decisions/0010](./decisions/0010-separated-contract-impl.md),
[decisions/0008](./decisions/0008-typed-client-inference.md).

A construct is authored in two parts. `contract` produces a typed, shareable
artifact carrying handler names and their I/O/error Schemas in its TYPE
(mirroring Restate's phantom `ServiceDefinition<P, M>`); `implement` binds each
handler name to an Effect and produces the server-side Layer.

### 1.1 Services (stateless)

```ts
const Greeter = RestateService.contract('greeter', {
  greet: { input: GreetInput, success: GreetSuccess, error: EmptyName },
})

const GreeterLive = RestateService.implement(Greeter, {
  greet: ({ name }) =>
    Effect.gen(function* () {
      if (name === '') return yield* new EmptyName({})
      const prefix = (yield* Greeting).prefix
      const id = yield* Restate.run('gen-id', Effect.sync(() => crypto.randomUUID()))
      return { message: `${prefix} ${name}`, id }
    }),
})
// GreeterLive : Layer<RestateImpl<"greeter">, never, Greeting>
```

The handler Effect is `Effect<Success, Error, R | <capabilities>>`. `R` is
satisfied from the shared application Layer; capabilities (section 3) are
provided per invocation. `error` is the only thing the `E` channel may carry
(R11).

### 1.2 Virtual Objects (keyed, typed State)

```ts
const Cart = RestateObject.contract('cart', {
  state: { items: Schema.Array(Item), total: Schema.Number },   // typed State (R06)
  handlers: {
    add: { input: Item, success: Schema.Void },                 // exclusive (default)
    total: { input: Schema.Void, success: Schema.Number, shared: true }, // read-only
  },
})

const CartLive = RestateObject.implement(Cart, {
  add: (item) =>
    Effect.gen(function* () {
      const items = (yield* State.get('items')) ?? []
      yield* State.set('items', [...items, item])               // needs StateWrite (R04)
    }),
  total: () => State.get('total').pipe(Effect.map((t) => t ?? 0)), // StateRead only
})
```

`add` is exclusive (gets `StateWrite` + `StateRead` + `ObjectKey`); `total` is
`shared: true` (gets `StateRead` + `ObjectKey` only). `State.set` in `total`
does not typecheck (R04, R05).

### 1.3 Workflows (one `run`, durable promises)

```ts
const Onboard = RestateWorkflow.contract('onboard', {
  state: { status: Schema.Literal('pending', 'approved', 'rejected') },
  payload: { input: OnboardInput, success: Schema.Void, error: OnboardError },
  signals: { approve: { input: Approval } },        // concurrent shared handlers
})

const OnboardLive = RestateWorkflow.implement(Onboard, {
  run: (input) =>
    Effect.gen(function* () {
      yield* State.set('status', 'pending')                          // WorkflowScope
      const decision = yield* Restate.race([
        DurablePromise.get<Approval>('approved'),                    // WorkflowScope
        Restate.sleep('7 days').pipe(Effect.as(Option.none())),
      ])
      // ...
    }),
  approve: (a) => DurablePromise.resolve('approved', a),             // shared handler
})
```

Exactly one `run` handler (gets `WorkflowScope` — full State + durable
promises); every signal/query handler is shared. `DurablePromise.resolve`
outside a workflow handler does not typecheck (R04).

### 1.4 Construct selection

| Construct      | Key            | State          | Concurrency                                  |
| -------------- | -------------- | -------------- | -------------------------------------------- |
| Service        | none           | none           | unbounded                                    |
| Virtual Object | per key        | typed, durable | exclusive serialized per key; shared concurrent |
| Workflow       | per workflow ID| typed, durable | one `run` exactly-once; signals concurrent   |

---

## 2. Per-invocation runtime boundary

Traces: R30, R07, R12, R13. POC reference: `Endpoint.materialize`,
`Endpoint.toTerminal`.

The shared application runtime is built once from the application Layer
(`Effect.runtime<R>()` captured at endpoint acquisition). Each SDK handler call
runs one boundary:

```
SDK calls handler(ctx, raw)
  1. decode      : effectSerde(input).deserialize(raw)        — TerminalError(400) on invalid (R16)
  2. provide     : RestateContext = ctx
                 + capability markers for this construct/kind  (R05)
                 + determinism layer (Clock/Random/sleep)      (R17, R18)
                 + (./otel) inbound span-context bridge        (R23)
  3. run         : Runtime.runPromiseExit(runtime)(handlerEffect)
  4a. Success    : effectSerde(success).encode(value) → return
  4b. Failure    : toTerminal(cause, errorSchema)              (R12, R13, R15)
```

`toTerminal` maps the Effect `Cause`:

- A typed failure matching the declared `error` Schema → `TerminalError`
  (`errorCode: 500`, body = Schema-encoded error, `metadata._tag` = the tagged
  error's `_tag`). No retry, propagates to caller (R12).
- A Restate suspension (`isSuspendedError`) → re-thrown as-is, never terminalized
  (R15).
- Any other defect / interrupt → squashed cause re-thrown so the SDK retries
  (R13).

The per-invocation `ctx` and capability markers are provided per call and never
placed in the long-lived application Layer (R30). The phantom
`ServiceDefinition` carries only `{ name }` at runtime; the implementation's
handler-map type is erased at this widened boundary while the contract's PUBLIC
type is preserved (see [decisions/0008](./decisions/0008-typed-client-inference.md)).

---

## 3. Typed capability-marker context model

Traces: R04, R05, R06. See
[decisions/0002](./decisions/0002-typed-capability-contexts.md).

Restate gates operations through a nominal context hierarchy; the binding mirrors
it as capability-marker services in the Effect `R` channel rather than one
untyped context.

```
RestateContext (Tag → raw restate.Context)   always provided
   markers provided per construct / handler kind:
   ┌─────────────────────┬──────────────────────────────────────────┐
   │ service handler     │ (RestateContext)                         │
   │ object exclusive    │ + ObjectKey + StateRead + StateWrite     │
   │ object shared       │ + ObjectKey + StateRead                  │
   │ workflow run        │ + WorkflowScope (StateRead + StateWrite  │
   │                     │   + DurablePromise + ObjectKey)          │
   │ workflow shared     │ + ObjectKey + StateRead + DurablePromise │
   └─────────────────────┴──────────────────────────────────────────┘
```

Each durable combinator carries the capability it needs in `R`:

| Combinator                       | Requires                | Backed by                |
| -------------------------------- | ----------------------- | ------------------------ |
| `Restate.run`, `Restate.sleep`   | `RestateContext`        | `ctx.run` / `ctx.sleep`  |
| `State.get`, `State.stateKeys`   | `StateRead`             | `ctx.get` / `ctx.stateKeys` |
| `State.set`, `State.clear`       | `StateWrite`            | `ctx.set` / `ctx.clear`  |
| `Awakeable.make` / resolve       | `RestateContext`        | `ctx.awakeable` / `resolveAwakeable` |
| `DurablePromise.get`/`resolve`   | `DurablePromise`        | `ctx.promise(name).*`    |
| `ctx.key` accessor               | `ObjectKey`             | `ctx.key`                |

Calling `State.set` (requires `StateWrite`) in a shared handler (provides only
`StateRead`) is a compile error (R04). State combinators are key- and
value-typed against the contract's `state` schema (R06). `materialize` provides
exactly the markers legal for the construct and handler kind (R05).

> `Context.Tag` does not model inheritance, so markers are independent services,
> not a subtype lattice — this is why the hierarchy is expressed as a set of
> provided markers per handler kind.

---

## 4. Serde: Effect Schema ↔ Restate `Serde`

Traces: R07, R08, R16. POC reference: `Serde.ts` (proven, 6/6 tests).

`effectSerde(schema)` bridges an Effect `Schema<A, I>` to a Restate `Serde<A>`:

```ts
effectSerde(schema) = {
  contentType: 'application/json',
  jsonSchema: JSONSchema.make(schema),               // R08: discovery payload
  serialize:   (a) => encode(JSON.stringify(Schema.encodeSync(schema)(a))),
  deserialize: (b) => Schema.decodeUnknownSync(schema)(JSON.parse(decode(b))),
}
```

One `effectSerde` governs every Restate-managed slot of that type — handler I/O,
State, `ctx.run` results, awakeable payloads, durable promises, ingress (A03).
A decode/encode `ParseError` is thrown as a `TerminalError` (`errorCode: 400`)
because a malformed payload is deterministic — retrying cannot help (R16). An
already-terminal nested error is not double-wrapped.

> `serialize`/`deserialize` are synchronous, so the schema must produce a sync
> validate (true for non-effectful schemas). Effectful/async transforms break the
> sync serde contract and are unsupported.

`@restatedev/restate-sdk-core`'s `serde.schema` (Standard Schema) is a viable
alternative seam, but the custom serde is used so a decode error becomes a
`TerminalError(400)` rather than a generic SDK error.

---

## 5. Error boundary

Traces: R11–R16. See
[decisions/0003](./decisions/0003-error-boundary-model.md). POC reference:
`Endpoint.toTerminal`, `RestateError.ts`.

```
Effect outcome                                  Restate outcome
──────────────────────────────────────────────────────────────────────────
success                              → encode  → return value
failure ∈ declared error Schema      → encode  → TerminalError(500,
                                                  body, metadata._tag)   no retry
Restate.retryable(eff, {retryAfter}) → throw   → RetryableError         retries
defect (incl. durable-combinator     → throw   → normal error           retries
  infra failures, orDie by default)
suspension (isSuspendedError)        → rethrow  → (not a failure)        resumes
```

- The handler `E` channel carries only declared business errors (R11). The
  binding's own bridge failures (`Restate.run`/`sleep`/serde/endpoint/ingress)
  are a single tagged `RestateError` (`reason` discriminator), defects by default
  (`orDie`), so they leave the domain channel and Restate retries them (R13).
- Observing a durable-combinator failure for compensation is opt-in: a handler
  may `catchTag('RestateError', …)` instead of letting it die.
- The ingress client's decode helper reverses the transport: it re-`Schema.decode`s
  a `TerminalError` body back into the original tagged error, so callers
  `catchTag` typed errors (R14, section 9.1).

---

## 6. Determinism layer

Traces: R17–R20. See [decisions/0004](./decisions/0004-determinism-layer.md),
[decisions/0005](./decisions/0005-deterministic-concurrency.md). POC reference:
`RestateContext.run` / `.sleep`.

### 6.1 Clock / Random / sleep

The boundary (section 2, step 2) provides a determinism layer over the handler
runtime:

| Effect default | Backed by   | Effect                                            |
| -------------- | ----------- | ------------------------------------------------- |
| `Clock` time   | `ctx.date`  | `Clock.currentTimeMillis` reads journaled time    |
| `Random`       | `ctx.rand`  | seeded, journaled (`ctx.rand.random` / `uuidv4`)  |
| `Clock.sleep`  | `ctx.sleep` | `Effect.sleep` / `Effect.timeout` become durable timers (R18, T02) |

So idiomatic Effect time/random reads are replay-safe without the author
choosing a special combinator (R17). Every in-handler `Effect.sleep` becomes a
journaled durable timer; a non-durable escape hatch may be added only if
validation shows it is needed (T02).

### 6.2 Deterministic concurrency

Parallel durable operations must journal in source order or replay diverges.

```
sequential (Effect.gen)         : safe, no special handling
pure in-handler concurrency     : allowed (Effect.all over non-durable effects)
durable concurrency             : Restate.all / Restate.race / Restate.any  (R19)
raw fiber over durable ops      : guarded / lint-flagged
```

`Restate.all` / `race` / `any` wrap the SDK's `RestatePromise.all/race/any` so
journal entries are created in deterministic order (R19). They are the only
sanctioned way to fan out durable operations.

### 6.3 Nondeterminism lint

An oxlint rule flags raw nondeterminism in handler bodies — `Date.now()`,
`new Date()`, `Math.random()`, `crypto.randomUUID()`, and un-journaled I/O
outside `Restate.run` — as an advisory backstop; the determinism layer is the
primary guarantee (R20).

---

## 7. Retry surfacing

Traces: R21, R22. See [decisions/0006](./decisions/0006-restate-owns-retries.md).

Durable retries are Restate's. The binding never wraps a durable operation in
`Effect.retry` / `Effect.repeat` (R21). Restate's controls are surfaced as typed
options:

- `retryPolicy` on service/handler builders: `maxAttempts`, `initialInterval`,
  `maxInterval`, `exponentiationFactor`, `onMaxAttempts: 'pause' | 'kill'`.
- `RunOptions` on `Restate.run`: per-step `maxRetryAttempts`, `maxRetryDuration`,
  intervals, factor; on giving up, `ctx.run` converts to a terminal failure.
- `Restate.retryable(effect, { retryAfter? })` / a `RetryableError` as the
  explicit retryable signal (R22).

`Effect.retry` / `Schedule` remain available for pure, non-durable computation
only (lint/doc enforced).

---

## 8. Endpoint and serving

Traces: R29, R30. POC reference: `Endpoint.layer` / `Endpoint.serve`.

The endpoint is a scoped `Layer`. Acquisition captures the shared runtime,
materializes each implementation, builds the h2c (Node HTTP/2 cleartext) server,
and starts listening; the finalizer closes the server (R29).

```ts
serve({ services: [GreeterLive, CartLive], port: 9080 }).pipe(
  Effect.provide(AppLayer),     // shared application services, built once
  NodeRuntime.runMain,          // SIGTERM → Fiber.interrupt → finalizers
)
```

`serve = Layer.launch(layer(opts))`. Under `NodeRuntime.runMain`, SIGTERM
interrupts the fiber, running the server-close finalizer and every scoped
application finalizer in the same scope — one atomic shutdown path (R29). The SDK
exposes no endpoint-level close; the binding owns the `http2.Http2Server` inside
`Effect.acquireRelease` to provide it.

---

## 9. Typed clients

Traces: R10, R14. See [decisions/0008](./decisions/0008-typed-client-inference.md).
From a contract alone (no hand-declared handler shape), the binding derives
fully typed clients.

### 9.1 External ingress client

`@restatedev/restate-sdk-clients`'s ingress wrapped as an Effect service:

```ts
const ingress = yield* RestateIngress
const result = yield* ingress.call(Greeter, 'greet', { name: 'Sarah' })
//    result : GreetSuccess          (Schema-validated args + typed success)

// typed error decode (R14): re-decode the terminal body into the tagged error
yield* ingress.call(Greeter, 'greet', { name: '' }).pipe(
  Effect.catchTag('EmptyName', () => Effect.succeed(fallback)),
)
```

Arguments are encoded through the contract's input serde; the result is decoded
through the success serde; a `TerminalError` body is re-decoded through the error
serde into the original tagged error so the caller `catchTag`s it rather than a
raw transport error (R14). Cross-language callers get the encoded JSON body plus
`_tag` only (T06).

### 9.2 In-handler service-to-service clients

`ctx.serviceClient` / `objectClient` / `workflowClient` (request/response,
suspends) and `*SendClient` (one-way) exposed as Effect combinators, typed from
the target contract:

```ts
yield* Restate.call(Greeter, 'greet', { name })                 // request/response
yield* Restate.send(Notifier, 'notify', payload, { idempotencyKey })  // one-way
yield* Restate.send(Reminder, 'fire', payload, { delay: '60 seconds' }) // delayed
```

Idempotency keys dedupe across calls; calls and sends are journaled, so a caller
crash recovers the result from the journal rather than re-issuing.

---

## 10. OpenTelemetry bridge (`./otel`)

Traces: R23–R25, R03. See [decisions/0007](./decisions/0007-otel-bridge.md).

```
[external caller traceparent]
        │ W3C extract (server)
        ▼
restate-server:  ingress_invoke ── invoke         (server spans)
        │ injects traceparent into attemptHeaders
        ▼
openTelemetryHook:  attempt <target> ── run (<name>)   (replay-aware, one per attempt / real run)
        │ context.with(attemptContext)
        ▼  bridge: trace.getActiveSpan().spanContext() → Tracer.withSpanContext
Effect spans (Effect.withSpan on boundary ops)
```

- The binding attaches `@restatedev/restate-sdk-opentelemetry`'s
  `openTelemetryHook` to every service. The hook owns the attempt and `ctx.run`
  spans, inbound W3C extraction, replay event suppression, and
  `recordException`-skip on suspension. The Effect layer MUST NOT re-emit them
  (R24).
- A single `TracerProvider` is shared with Effect via `@effect/opentelemetry`'s
  `NodeSdk.layer`, so the hook's `@opentelemetry/api` tracer and Effect's tracer
  resolve to the same provider.
- At handler entry the boundary reads `trace.getActiveSpan()?.spanContext()` and
  applies `Tracer.withSpanContext`, parenting all in-handler Effect spans under
  the attempt span → one coherent trace (R23).
- An `isReplaying` service (from the Restate context) gates custom span events
  and metric increments so they emit exactly once across replays; metric
  increments belong inside `Restate.run` closures (which run once) (R24, R25).

These deps live behind `./otel` so the core stays dependency-light (R03, A09).

---

## 11. Testing harness (`./testing`)

Traces: R26–R28. See
[decisions/0009](./decisions/0009-effect-native-testing-harness.md). POC
reference: `test/restate-server.ts`.

A scoped `Layer` that, on acquire, boots a native `restate-server` (no Docker) on
ephemeral ports against an isolated temp base dir, waits for the admin health
endpoint, builds and serves the endpoint, and registers the deployment; on
release it shuts the server down and removes the base dir.

```ts
it.effect('greet round-trips', () =>
  Effect.gen(function* () {
    const harness = yield* RestateTestHarness          // scoped Layer
    const result = yield* harness.ingress.call(Greeter, 'greet', { name: 'Sarah' })
    expect(result.message).toBe('Hello Sarah')
    const status = yield* harness.stateOf(Onboard, 'wf-1').get('status')  // State inspection
  }).pipe(Effect.provide(RestateTestHarness.layer({ services: [GreeterLive] }))))
```

The harness exposes the typed ingress client and State inspection (R26).
Ephemeral ports + isolated base dir make tests parallel-safe and fix the POC
harness's fixed-port flakiness (R27). CI runs the integration tests as a
dedicated job with `restate-server` on `$PATH` from `nix/restate.nix`
(`allowUnfree` scoped to `restate`), serialized, with a generous timeout (R28).
The harness is public API and must stay stable.

---

## 12. Saga / compensation (future)

Spec note, not v1 surface. See [decisions/0001](./decisions/0001-thin-faithful-restate-binding.md)
(faithful binding) and the [Deferred](#deferred-designed-for-later) list.

Restate ships no saga type; the pattern is built from primitives. The intended
Effect-native mechanism:

```
acquireRelease / onError finalizers, each compensation backed by Restate.run
    step succeeds → register compensation (a Restate.run that undoes it)
    later terminal error OR Effect interruption ↔ Restate cancel
        → run registered compensations in reverse (each a durable Restate.run)
```

The mapping to verify when this is built: Effect interruption ↔ Restate
cancellation (cooperative cancel surfaces at the next await point precisely so
compensation can run), and that compensations are themselves durable steps so
they survive replay. A first-class `withCompensation` helper (echoing
`@effect/workflow`) is deferred; until then, the saga is expressible by hand with
`Restate.run` + Effect finalizers.

---

## Deferred (designed for later)

Out of v1 scope, designed to slot in without reshaping the core:

- **Serverless targets** — Lambda / fetch / Cloudflare Workers endpoints
  (`createEndpointHandler` over the SDK's `/lambda` and `/fetch` subpaths, with a
  module-scope runtime and `dispose()` in the platform shutdown hook). v1 is
  node-h2c only (A08).
- **First-class saga helper** — a `withCompensation` combinator over the
  section 12 mechanism.
- **Scheduling / cron sugar** — typed wrappers over delayed `send` +
  self-reschedule.
- **`JournalValueCodec`** — the experimental endpoint-global byte layer below
  serde (compression / encryption).
- **Admin / management wrappers** — typed wrappers over the admin API
  (registration, invocation cancel/kill/pause/resume, attach).

## Open design questions

- **DQ1 Non-durable sleep escape hatch:** Does the durable-sleep remap (R18, T02)
  need a non-durable escape hatch for tight internal sleeps? Resolved by
  validation measuring durable-timer overhead in a representative handler. (See
  [decisions/0004](./decisions/0004-determinism-layer.md).)
- **DQ2 Pure-vs-durable concurrency guard:** How is "concurrency over durable
  operations" detected for the R19 guard — lint only, a typed marker that
  durable combinators carry, or both? Resolved by prototyping the lint rule
  against a fan-out handler.
- **DQ3 Capability erasure shape:** What exact internal representation lets
  `materialize` provide markers per handler kind while keeping the contract's
  public type clean (R05)? Resolved by the builder-generics prototype. (See
  [decisions/0002](./decisions/0002-typed-capability-contexts.md),
  [decisions/0008](./decisions/0008-typed-client-inference.md).)
