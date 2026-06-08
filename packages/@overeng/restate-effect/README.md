# @overeng/restate-effect

A fully Effect-idiomatic, type-safe binding to [Restate](https://restate.dev)'s
durable-execution engine. It exposes Restate's own model — Services, Virtual
Objects, Workflows, and the durable context primitives — as Effect-returning
combinators, layering Effect idioms (Schema I/O, tagged errors, Layers and
Scopes, OpenTelemetry) on top without hiding Restate.

This is a faithful binding, not a vendor-neutral facade: Restate is the
programming model and the engine. If you want Effect's own durable engine, use
`@effect/workflow` + `@effect/cluster` instead. See
[docs/vrs/vision.md](./docs/vrs/vision.md) for the full motivation and
[docs/vrs/spec.md](./docs/vrs/spec.md) for the design.

## Status

The stable surface documented here — Services, Virtual Objects, Workflows, the
Schema serde + typed error boundary, determinism, durable steps/calls/awakeables,
cancellation, the endpoint, `./otel`, and `./testing` (the native-server harness
AND the server-free in-memory test context) — is implemented and verified
end-to-end against a real native `restate-server`.

Every code snippet in this README is a real, compiled-and-run example. The files
live in [`examples/`](./examples), are type-checked by `dt ts:check`, and are
driven against a native `restate-server` by `src/examples.integration.test.ts`
(under `dt check:all`). A snippet that stopped working would fail CI.

## Install

```sh
pnpm add @overeng/restate-effect effect
```

`@restatedev/restate-sdk` and `@restatedev/restate-sdk-clients` come bundled. The
`./otel` subpath additionally needs `@effect/opentelemetry`, `@opentelemetry/api`,
`@opentelemetry/sdk-metrics` (the metrics path), and
`@restatedev/restate-sdk-opentelemetry` (peer deps you install when you use it). To
run an endpoint you also bring `@effect/platform-node` for
`NodeRuntime.runMain`. You need a `restate-server` binary to actually run handlers
(via Restate's CLI/Docker in production, or the `./testing` harness in tests).

## Mental model

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

Two artifacts per construct: a **contract** (shareable, client-side, no server
deps) and an **implementation** (the server-side Layer). The endpoint
materializes implementations against one shared application runtime and runs each
invocation through a single boundary that decodes the input, provides the
per-invocation context + capability markers + a journaled `Clock`/`Random`, runs
your Effect, and maps the outcome back to Restate.

The three constructs:

| Construct      | Key             | State          | Concurrency                                     |
| -------------- | --------------- | -------------- | ----------------------------------------------- |
| Service        | none            | none           | unbounded                                       |
| Virtual Object | per key         | typed, durable | exclusive serialized per key; shared concurrent |
| Workflow       | per workflow ID | typed, durable | one `run` exactly-once; signals concurrent      |

## A first Service

A Service is stateless. Author a contract from Schemas, bind each handler to an
Effect, serve it, and call it through the typed ingress client.
([`examples/01-service.ts`](./examples/01-service.ts))

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

Serve it (a mixed `services` array can hold Services, Objects, and Workflows on
one endpoint), and call it. ([`examples/04-endpoint.ts`](./examples/04-endpoint.ts),
[`examples/06-ingress-client.ts`](./examples/06-ingress-client.ts))

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
`Layer<never, RestateError, AppR>`.

Three distinct ports are in play; do not conflate them:

| Port             | Owner                 | Default | Role                                       |
| ---------------- | --------------------- | ------- | ------------------------------------------ |
| ingress          | `restate-server`      | 8080    | external entry point (callers → server)    |
| admin            | `restate-server`      | 9070    | health, deployment registration, State API |
| handler endpoint | this binding's server | 9080    | discovery + invoke (server → handlers)     |

The binding owns only the handler-endpoint port (the `port` you pass to `serve`).

## Virtual Objects

A Virtual Object is keyed and holds typed, durable State. Handlers are
**exclusive** by default (serialized per key, full State access) or `shared: true`
(concurrent, read-only State). Writing State in a shared handler is a compile
error. The `state` block is the single source of truth for State keys and value
Schemas. ([`examples/02-virtual-object.ts`](./examples/02-virtual-object.ts))

```ts
import { Effect, Schema } from 'effect'
import { RestateObject, State } from '@overeng/restate-effect'

const CounterState = { count: Schema.Number } as const
const Counter = State.for(CounterState) // typed, capability-gated State combinators

const CounterObj = RestateObject.contract('counter', {
  state: CounterState,
  handlers: {
    add: { input: Schema.Number, success: Schema.Number }, // exclusive (default)
    get: { input: Schema.Void, success: Schema.Number, shared: true }, // read-only
  },
})

const CounterLive = RestateObject.implement<typeof CounterObj>(CounterObj, {
  add: (amount) =>
    Effect.gen(function* () {
      const current = (yield* Counter.get('count')) ?? 0 // undefined = unset
      yield* Counter.set('count', current + amount) // requires StateWrite — legal here
      return current + amount
    }).pipe(Effect.orDie),
  // A `Counter.set(...)` in this shared handler would NOT type-check.
  get: () =>
    Counter.get('count').pipe(
      Effect.map((c) => c ?? 0),
      Effect.orDie,
    ),
})
```

Call a keyed handler with the per-invocation key as the second argument:
`objectCall(CounterObj, 'cart-1', 'add', 3)`. State is isolated per key.

## Workflows

A Workflow has one `run` handler that executes exactly-once per workflow ID, plus
`signal` and `query` shared handlers. The `run` handler owns the full capability
set; signals/queries are shared (read-only State) and may resolve/await durable
promises. A **durable promise** is the rendezvous between `run` (which awaits it)
and a signal (which resolves it) — the await is journaled, so it survives process
restarts. ([`examples/03-workflow.ts`](./examples/03-workflow.ts))

```ts
import { Effect, Schema } from 'effect'
import { DurablePromise, RestateWorkflow, State } from '@overeng/restate-effect'

const Decision = Schema.Struct({ approved: Schema.Boolean })
const Approval = DurablePromise.for(Decision) // typed by its payload Schema

const StatusState = { status: Schema.Literal('pending', 'approved', 'rejected') } as const
const Status = State.for(StatusState)

const ApprovalWf = RestateWorkflow.contract('approval', {
  state: StatusState,
  payload: { input: Schema.String, success: Schema.Boolean }, // the `run` I/O
  signals: { approve: { input: Schema.Void, success: Schema.Void } },
  queries: { status: { input: Schema.Void, success: Schema.String } },
})

const ApprovalLive = RestateWorkflow.implement<typeof ApprovalWf>(ApprovalWf, {
  run: () =>
    Effect.gen(function* () {
      yield* Status.set('status', 'pending')
      const decision = yield* Approval.get('decision') // durably suspends until resolved
      yield* Status.set('status', decision.approved ? 'approved' : 'rejected')
      return decision.approved
    }).pipe(Effect.orDie),
  approve: () => Approval.resolve('decision', { approved: true }).pipe(Effect.orDie), // signal
  status: () =>
    Status.get('status').pipe(
      Effect.map((s) => s ?? 'pending'),
      Effect.orDie,
    ), // query
})
```

The Workflow ingress surface is `workflowSubmit` / `workflowAttach` /
`workflowOutput` plus `workflowCall` (signals/queries); the `run` handler is not
directly callable.

```ts
import { Effect } from 'effect'
import { workflowAttach, workflowCall, workflowSubmit } from '@overeng/restate-effect'

const run = Effect.gen(function* () {
  yield* workflowSubmit(ApprovalWf, 'wf-1', 'please review') // idempotent; returns at once
  yield* workflowCall(ApprovalWf, 'wf-1', 'approve', undefined) // a signal
  return yield* workflowAttach(ApprovalWf, 'wf-1') // awaits the run's typed success
}).pipe(Effect.provide(IngressLayer))
```

## Schema I/O and the typed error boundary

Every Restate-managed value — handler input/output, State, `ctx.run` results,
awakeable payloads, durable promises, ingress — is governed by a serde built from
an Effect `Schema`. Decode failures are classified by slot:

- an **ingress** input slot → `TerminalError(400)` (a malformed request is a
  deterministic bad request; retrying cannot help);
- an **internal** slot (State, journal, payloads) → a defect Restate retries (a
  decode failure there is a corrupt journal, not the current caller's fault).

The error channel means one thing. A handler's `E` channel carries only its
declared business errors. They cross the wire as terminal errors and decode back
into the original tagged error on the caller side, so callers `catchTag` typed
domain errors. The binding's own bridge failures (`Restate.run`/serde/endpoint/
ingress) are a single tagged `RestateError`, defects by default, that Restate
retries — they never enter your domain channel.

```
Effect outcome                                Restate outcome
──────────────────────────────────────────────────────────────────────────
success                          → encode  → return value
failure ∈ declared error Schema  → encode  → TerminalError(code, body)   no retry
  (code from the terminal/retryable annotation, default 500)
retryable-annotated failure      → throw   → retryable error             retries
defect (incl. RestateError)      → throw   → normal error                retries
interrupt (Restate cancel)       → finalizers ran → not terminal, not retried
```

The ingress decode helper (`callTyped` / `objectCallTyped` / `workflowAttach`)
reverses the transport for you; `call` / `objectCall` leave the raw transport
`RestateError` if you prefer to handle it. ([`examples/06-ingress-client.ts`](./examples/06-ingress-client.ts))

## Determinism

Restate replays handlers, so every source of nondeterminism must be journaled.
This binding makes the common cases correct by construction
([`examples/05-determinism.ts`](./examples/05-determinism.ts)):

- Effect's `Clock` and `Random` are backed by the journaled context, so idiomatic
  `Clock.currentTimeMillis` / `Random.nextIntBetween` reads are replay-safe. The
  sync `Clock.unsafeCurrentTime*` reads a per-attempt frozen base (time does not
  advance mid-attempt — the deterministically-correct behavior).
- A side effect or a raw nondeterministic call goes inside `Restate.run`, whose
  result is journaled once and replayed verbatim. Inside a `run` closure, a nested
  `ctx.*` / `State.*` / `Restate.sleep` is a compile error.
- Durable waits are **explicit**, named combinators — not a remap of
  `Effect.sleep`. `Restate.sleep` / `timeout` / `race` / `all` / `any` become
  Restate-durable timers/races that survive suspension and restarts. A bare
  `Effect.sleep` stays a non-durable in-process timer.

```ts
import { Clock, Effect, Random } from 'effect'
import { Restate } from '@overeng/restate-effect'

const body = Effect.gen(function* () {
  const at = yield* Clock.currentTimeMillis // journaled (ctx.date)
  const roll = yield* Random.nextIntBetween(1, 7) // journaled (ctx.rand)
  const token = yield* Restate.run(
    'mint-token',
    Effect.sync(() => crypto.randomUUID()),
  ).pipe(
    Effect.orDie, // raw nondeterminism / external I/O goes inside `Restate.run`
  )
  yield* Restate.sleep(10, 'settle').pipe(Effect.orDie) // a durable timer
  return { at, roll, token }
})
```

Durable concurrency takes **descriptors** (not opaque Effects) so the journal
order is the source order. The combinator awaits the single combined promise once;
map the result after:

```ts
// race two durable steps; result is the first to resolve
Restate.race([
  Restate.runDescriptor('fetch-a', () => fetchA()),
  Restate.runDescriptor('fetch-b', () => fetchB()),
])

// bound one durable step by a deadline: Some(value) or undefined on timeout
Restate.timeout(
  Restate.runDescriptor('slow-op', () => slow()),
  1_000,
)
```

An oxlint rule (`overeng/no-raw-nondeterminism`) flags a raw `Date.now()` /
`Math.random()` / `crypto.randomUUID()` in a handler body outside `Restate.run`
as an advisory backstop; the journaled layer + explicit combinators are the
primary guarantee.

## Durable steps, calls, and awakeables

`Restate.run(name, effect, options?)` is the durable side-effect step: Restate
journals its result so later attempts replay it instead of re-executing. Its
`name` is load-bearing for trace identity and journal labeling — prefer distinct
names per step. `options` surfaces Restate's per-step retry/backoff controls;
never wrap a durable step in `Effect.retry` (that double-retries non-durably).

In-handler service-to-service clients invoke another construct from inside a
handler, typed from the target contract. `Restate.call` is request/response
(durably journaled — a caller crash recovers the result rather than re-issuing);
`Restate.send` is one-way (optionally delayed — a durable, fault-tolerant cron).
([`examples/07-clients-idempotency-awakeables.ts`](./examples/07-clients-idempotency-awakeables.ts))

Idempotency is declared once on the input field via `Restate.idempotencyKey` — the
single source. The client reads the key off that field; there is no call-site
option to keep in sync.

```ts
import { Schema } from 'effect'
import { Restate } from '@overeng/restate-effect'

const NotifyInput = Schema.Struct({
  requestId: Restate.idempotencyKey(Schema.String), // this field's value IS the key
  body: Schema.String,
})

// in a handler:
const greeting = yield * Restate.call(Greeter, 'greet', { name }).pipe(Effect.orDie)
yield * Restate.send(Notifier, 'notify', { requestId: `welcome-${name}`, body }).pipe(Effect.orDie)
yield * Restate.send(Reminder, 'fire', payload, { delayMillis: 60_000 }).pipe(Effect.orDie) // delayed
```

An **awakeable** is a typed external-completion token. A handler creates one,
hands its `id` to an external system, and suspends on its `promise` until the
external system resolves it (in-handler via `Awakeable.resolve`, or from ingress
via `ingressResolveAwakeable`):

```ts
import { Awakeable } from '@overeng/restate-effect'

const PaymentResult = Schema.Struct({ token: Schema.String })

// in a handler:
const { id, promise } = yield * Awakeable.make(PaymentResult)
// ... persist `id`, hand it to the payment provider ...
const payment = yield * promise // durably suspends until resolved

// from ingress (or another handler):
yield * ingressResolveAwakeable(PaymentResult, id, { token: 'ok' })
```

## Self-reschedule and durable scheduling

A durable daemon — a poller or watcher that wakes periodically, forever — is NOT a
held-open `for(;;){ poll(); sleep() }`. The idiomatic Restate shape is a chain of
**delayed self-sends**: each invocation does ONE bounded unit of work, re-arms
itself via a delayed self-send, and RETURNS. Each invocation therefore has a
bounded journal (it does not grow with the number of cycles), the per-key write
lock is released between cycles, and crash/restart durability is free — the pending
delayed timer survives a server restart and re-fires.

**The p99 latency rule.** A durable daemon uses a one-way `send` + a delayed
self-send, NEVER a blocking `call`. A blocking ingress `call` into a per-key
Virtual Object serializes behind that key's write lock and stacks on top of the
platform's retry backoff; under load this was measured at an 18.4s p99. The
self-send shape returns immediately after enqueuing the next cycle.

Two levels, both in [`examples/12-self-reschedule.ts`](./examples/12-self-reschedule.ts):

**The narrow primitive — `RestateScheduled.make` (a.k.a. `Restate.pollLoop`).** You
write ONE `cycle` effect; the primitive materializes a Virtual Object that owns the
whole recurring lifecycle (schedule, stop condition, error policy, overlap
prevention, and a `start`/`stop`/`status` control surface):

```ts
import { Effect, Schema } from 'effect'
import { Restate, RestateScheduled, State } from '@overeng/restate-effect'

const WatcherState = { cursor: Schema.Number, itemsSeen: Schema.Number } as const
const Watcher = State.for(WatcherState)

const NotionWatcher = RestateScheduled.make<typeof WatcherState>({
  name: 'notion-watcher',
  domainState: WatcherState,
  schedule: RestateScheduled.Schedule.fixedDelay(200), // 200ms gap between cycles
  onCycleError: RestateScheduled.OnCycleError.skipToNext(), // a bad cycle never stalls cadence
  cycle: ({ key }) =>
    Effect.gen(function* () {
      const cursor = (yield* Watcher.get('cursor')) ?? 0
      // per-cycle retry lives INSIDE a BOUNDED Restate.run (there is no retryCycle knob)
      const page = yield* Restate.run(`poll(${key}@${cursor})`, pollOnePage(cursor), {
        maxRetryAttempts: 3,
      })
      yield* Watcher.set('cursor', page.nextCursor)
      return page.done ? { stop: true } : { stop: false } // data-driven stop
    }),
})
// drive it from ingress: objectCall(NotionWatcher.contract, key, 'start' | 'stop' | 'status', …)
```

- `schedule`: `Schedule.fixedDelay(ms)` only in v1 (`fixedRate`/`cron` deferred).
- `onCycleError`: `skipToNext` (default — swallow a failing cycle, keep cadence) or
  `stopLoop` (stop the loop, status `failed`).
- Stop: data-driven `{ stop: true }`, count-driven `stopWhen` / `maxIterations`, or
  external `stop` — all end as status `completed` / `stopped`.
- `start` re-arms under a fresh **generation token**, so a stale in-flight timer
  (from before a `stop`/restart) no-ops when it lands — no overlapping chains.
- There is intentionally **no `retryCycle` knob**: per-cycle durable retry belongs
  inside a BOUNDED `Restate.run`. An unbounded `Restate.run` retries forever and
  wedges the per-key write lock so `start`/`stop` block.

**The building block — `Restate.reschedule`.** The typed delayed self-send the
primitive is built on, for a hand-rolled loop that does not fit the primitive. The
author passes the lexical `self` contract (the SDK has no runtime self-reflection);
the send targets `Restate.key`, so it stays on the same single-writer instance:

```ts
// inside a keyed handler — re-arm one of this Object's own handlers after a delay:
yield * Restate.reschedule({ contract: Self, method: 'cycle', input, delayMillis: 200 })
```

Re-arm BEFORE the fallible work (advance the cursor + reschedule first, both
journaled, THEN poll), so a re-arm journaled before a failure is still delivered
and the loop survives a failing cycle.

## Cancellation and lifecycle

When an invocation is cancelled (via `Restate.cancel`, ingress, or the admin API),
the cancellation surfaces inside the handler as an Effect **interruption** at the
next durable await point. Ordinary Effect finalizers run before the attempt
unwinds — `acquireRelease` releases, `onInterrupt` fires, saga compensations run.
The boundary then maps the interruption to a `CancelledError`: neither a domain
failure nor a defect, and not retried.
([`examples/10-cancellation.ts`](./examples/10-cancellation.ts))

```ts
import { Effect } from 'effect'
import { Restate } from '@overeng/restate-effect'

const body = Effect.gen(function* () {
  yield* Effect.acquireRelease(
    acquireResource,
    () => releaseResource, // runs on success, error, OR cancellation
  )
  yield* Restate.sleep(60_000, 'long-wait').pipe(Effect.orDie) // cancel interrupts here
}).pipe(Effect.scoped)
```

This is the mechanism a first-class saga helper will be built on; today you
express compensations by hand with `Restate.run` + Effect finalizers.

The endpoint itself is a scoped Layer: under `serve` + `NodeRuntime.runMain`,
SIGTERM interrupts the fiber, closing the HTTP/2 server and running every scoped
application finalizer in one atomic shutdown path.

## Annotations

Restate-specific facts are carried on the schema and read once at the site that
owns the fact. Each `Restate.*` annotation returns the same schema with the fact
attached. ([`examples/08-annotations.ts`](./examples/08-annotations.ts))

| Annotation                  | On                   | Drives                                     |
| --------------------------- | -------------------- | ------------------------------------------ |
| `terminal({ errorCode })`   | `Schema.TaggedError` | per-error status code (non-retryable)      |
| `retryable()`               | `Schema.TaggedError` | Restate retries instead of propagating     |
| `serde({ contentType, … })` | value schema         | overrides `application/json` / JSON Schema |
| `retention({ journal, … })` | contract / I/O       | journal/idempotency/workflow retention     |
| `idempotencyKey`            | input struct field   | the single idempotency-key source          |
| `sensitive` / `redacted`    | value field          | encrypt the field on the wire/journal      |

```ts
import { Restate, aesGcmRedactionLayer } from '@overeng/restate-effect'

class NotFound extends Schema.TaggedError<NotFound>('example/NotFound')('NotFound', {
  id: Schema.String,
}) {}
const NotFoundTerminal = Restate.terminal(NotFound, { errorCode: 404 }) // status 404, no retry

const LookupInput = Restate.retention(Schema.Struct({ id: Schema.String }), {
  idempotency: '5 minutes',
  journal: '1 hour',
})

const StoreSecret = Schema.Struct({
  account: Schema.String,
  pin: Restate.sensitive(Schema.String), // ciphertext on the wire/journal
})
```

Provide a `RestateRedaction` cipher in the application Layer whenever any served
schema marks a field sensitive — otherwise encode/decode fails with a clear
`RedactionCipherMissingError` (never silently plaintext). `aesGcmRedactionLayer(key)`
is a ready AES-256-GCM reference; the 32-byte key is your secret.

Per-handler/service retry and timeout knobs live in the builder `options`, not on
the schema. Durable retries are Restate's — never re-implement them with Effect
schedules:

```ts
const Vault = RestateService.contract('vault', {
  lookup: {
    input: LookupInput,
    success: Schema.String,
    error: NotFoundTerminal,
    options: {
      retryPolicy: {
        maxAttempts: 5,
        initialIntervalMillis: 100,
        maxIntervalMillis: 5_000,
        exponentiationFactor: 2,
        onMaxAttempts: 'pause', // resumable from the CLI/UI on giving up
      },
      inactivityTimeoutMillis: 30_000,
    },
  },
})
```

### Retryable errors and `retryAfter`

A domain error can be marked **retryable** so the boundary throws it
non-terminally and Restate retries (instead of failing the caller). `retryAfter`
sets a floor before the next attempt — either a **static** `Duration` shorthand or
an **instance projection** read off the actual failing error (mirroring
`idempotencyKey` — the fact lives on the schema, read once at the boundary):

```ts
// static floor
const Throttled = Restate.retryable(
  Schema.asSchema(class extends Schema.TaggedError<any>()('Throttled', {}) {}),
  { retryAfter: '30 seconds' },
)

// projection: read the floor off THIS error instance (e.g. a 429's header)
class RateLimited extends Schema.TaggedError<RateLimited>()('RateLimited', {
  retryAfterMillis: Schema.Number,
}) {}
const RateLimitedSchema = Restate.retryable(Schema.asSchema(RateLimited), {
  retryAfter: (e) => e.retryAfterMillis, // typed against the error; undefined → default backoff
})
```

The projection is applied to the very error that failed, so a Notion 429's
`e.retryAfterMillis` becomes the retry floor without threading it through a
call-site option. (`src/error-transport.test.ts` verifies both forms.)

### Clean error channel: infra failures are defects, not typed `E`

The durable combinators (`Restate.run` / `sleep` / `timeout` / `all` / `race` /
`any` / `State.*` / `Awakeable.make().promise`) have a **clean `E`** — they carry
**no** `RestateError`. Only the inner effect's own domain `E` flows through
`Restate.run`. A durable-op infrastructure failure is classified at the boundary
as a **defect** (transient infra → Restate retries; a terminally-failed step →
fail, no retry), so you never write a no-op `catchTag('RestateError', Effect.die)`
to scrub it out of a handler's typed channel:

```ts
greet: ({ name }) =>
  Effect.gen(function* () {
    if (name === '') return yield* new EmptyName() // domain error → handler `E`
    // No `.orDie` needed: `Restate.run`'s `E` is `never` here (the closure declares
    // no domain error), and an infra failure is a defect handled at the boundary.
    const id = yield* Restate.run(
      'gen-id',
      Effect.sync(() => crypto.randomUUID()),
    )
    return { message: `Hello ${name}`, id }
  })
```

To OBSERVE a durable step's outcome (for compensation / sagas) instead of letting
a failure propagate, use `Restate.runExit(name, effect)` → `Effect<Exit<A, E>>`:
the `Exit` captures success, a domain `E` failure, and an infra failure (a
`Cause.Die` carrying the `RestateError`, via `Cause.dieOption`), so you can branch
and run a compensating durable step.

### Awakeables (and other durable ops) in a deterministic race

Every durable op exposes a **descriptor** so it joins `Restate.all` / `race` /
`any` deterministically (issued in journal-source order, awaited once) — not just
`run`/`sleep`, but also durable promises (`DurablePromise.for(S).getDescriptor`),
in-handler calls (`Restate.callDescriptor` / `objectCallDescriptor`), and
**awakeables** (`Awakeable.make(S).descriptor`). This replaces the in-process
`Effect.raceFirst` workaround, which loses journal-order determinism:

```ts
const { id, promise, descriptor } = yield * Awakeable.make(Schema.String)
// resume on EITHER the external completion OR a durable deadline — replay-stable
const winner =
  yield *
  Restate.race([
    descriptor,
    Restate.runDescriptor('deadline', () => Promise.resolve('__timeout__')),
  ])
```

(`examples/05-determinism.ts` `awakeableRaceExample` compiles + is type-checked.)

## OpenTelemetry (`./otel`)

The opt-in OTel bridge wires the external caller, the Restate server spans, the
SDK attempt/`run` spans, and your in-handler Effect spans into **one coherent
trace** — AND makes an invocation operable from Grafana with span attributes +
metrics. The otel packages live behind this subpath, so the core `.` export stays
dependency-light. ([`examples/09-otel.ts`](./examples/09-otel.ts))

```ts
import { NodeRuntime } from '@effect/platform-node'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-base'
import { Effect } from 'effect'
import { serve } from '@overeng/restate-effect'
import { RestateOtel } from '@overeng/restate-effect/otel'

// `layer` registers ONE global TracerProvider + a global context manager (the
// load-bearing step that makes the attempt span resolve at handler entry), binds
// Effect's tracer to the same provider, AND — when a metric exporter/reader is
// given — registers a MeterProvider sharing the same Resource and binds Effect's
// `Metric` to it. Omit the metric config for a traces-only setup.
const OtelLayer = RestateOtel.layer({
  resource: { serviceName: 'greeter' },
  exporter: new ConsoleSpanExporter(), // a BatchSpanProcessor over OTLP in prod
  metricExporter: new OTLPMetricExporter({ url: 'http://localhost:4318/v1/metrics' }),
})

// `withOtel` attaches the hook + inbound span-context bridge + the boundary
// observer (span-attribute stamping) to every handler.
serve(RestateOtel.withOtel({ services: [GreeterLive], port: 9080 })).pipe(
  Effect.provide(Greeting.Default),
  Effect.provide(OtelLayer),
  NodeRuntime.runMain,
)
```

### Span attributes

The boundary auto-stamps the **attempt span** with the identity an operator slices
on — `restate.service`, `restate.handler`, `restate.object.key` (Objects/Workflows)
— and, on a failure, `restate.error.tag` (the domain error `_tag`) +
`restate.error.class` (`terminal` | `retryable` | `cancelled`). For custom business
attributes, use `Restate.annotateSpan` in a handler:

```ts
import { Restate } from '@overeng/restate-effect'

const sync = (input: SyncInput) =>
  Effect.gen(function* () {
    yield* Restate.annotateSpan({ dataSourceId: input.dataSourceId })
    // … now every span in this invocation is sliceable by `dataSourceId` in Tempo.
  })
```

### Metrics

When a `metricExporter`/`metricReader` is configured, the bridge emits a
REPLAY-AWARE auto baseline (exactly-once across attempts/replays):

| Metric | Labels |
| --- | --- |
| `restate_invocations_total` | `service`, `handler`, `outcome` (`success`/`terminal`/`retryable`/`cancelled`) |
| `restate_invocation_duration_ms` | `service`, `handler`, `outcome` |
| `restate_attempts_total` | `service`, `handler` (retries = attempts − success/terminal) |
| `restate_durable_steps_total` | `step` (the `Restate.run` name) |
| `restate_awakeable_wait_ms` | — |
| `restate_poll_loop_cycles_total` | `name`, `outcome` (`ok`/`error`/`stopped`) |

User counters/histograms export through the SAME meter (any Effect `Metric`). For
exactly-once custom telemetry, route span events / metric increments through
`Restate.run` (runs once on real execution, skipped on replay) — preferred over the
version-fragile `isReplaying` flag.

## Testing (`./testing`)

`RestateTestHarness.layer({ services, appLayer })` is one scoped Layer that boots
a native `restate-server` (no Docker) on ephemeral ports against an isolated temp
dir, serves your endpoint with `appLayer` threaded into the served runtime,
registers the deployment, and exposes a typed ingress client + typed `stateOf`
State inspection. On release it shuts the server down and removes the temp dir.
([`examples/11-testing.ts`](./examples/11-testing.ts),
[`src/examples.integration.test.ts`](./src/examples.integration.test.ts))

```ts
import { it } from '@effect/vitest'
import { Effect } from 'effect'
import { describe, expect } from 'vitest'
import { RestateTestHarness, serverAvailable } from '@overeng/restate-effect/testing'

const Harness = RestateTestHarness.layer({
  services: [GreeterLive, CounterLive],
  appLayer: Greeting.Default,
  disableRetries: true, // surface failures immediately instead of retrying
})

describe.skipIf(!serverAvailable)('greeter', () => {
  it.layer(Harness, { timeout: 90_000 })('round-trips', (it) => {
    it.effect('greets', () =>
      Effect.gen(function* () {
        const harness = yield* RestateTestHarness
        const ok = yield* harness.ingress.callTyped(Greeter, 'greet', { name: 'Sarah' })
        expect(ok.message).toBe('Hello Sarah')

        // typed State inspection: seed a pre-condition, assert a post-condition
        yield* harness.stateOf(CounterObj, 'cart-1').set('count', 40)
        const bumped = yield* harness.ingress.objectCall(CounterObj, 'cart-1', 'add', 1)
        expect(bumped).toBe(41)
      }),
    )
  })
})
```

`harness.stateOf(contract, key)` is key- and value-typed against the contract's
`state` block and goes over the Admin API — seed pre-conditions and assert
post-conditions without invoking a handler. Two determinism-hunting flags mirror
the SDK test environment: `alwaysReplay: true` forces a replay at every suspension
(surfaces journal-shape divergence) and `disableRetries: true` surfaces failures
immediately. `serverAvailable` lets a suite gracefully `skipIf` when no native
binary is on `$PATH`.

### In-memory `TestContext` (server-free unit tests)

For fast unit tests of a handler's LOGIC and State transitions — no server, no
Docker — `./testing` also exports a FAITHFUL in-memory `RestateContext`. It is a
real in-memory implementation, not a stub: State is a real `Map` (round-tripped
through the same serde the handler uses), `Restate.run(name, …)` executes once and
memoizes by name (journaled-once), `ctx.date`/`ctx.rand` are deterministic (seeded),
and `ctx.sleep` is a controllable no-op. Provide it over the real handler effect and
assert on the result AND the State `Map` (verified by
[`src/TestContext.test.ts`](./src/TestContext.test.ts)):

```ts
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { makeTestContextLayer } from '@overeng/restate-effect/testing'
import { CounterLive } from './counter.ts' // your RestateObject.implement(...)

describe('counter handler logic', () => {
  it('add reads + writes State (server-free)', () =>
    Effect.gen(function* () {
      // seed a pre-condition in the backing State Map
      const state = new Map<string, unknown>([['count', 40]])
      // run the REAL `add` handler against the in-memory context
      const next = yield* CounterLive.impl
        .add(3)
        .pipe(Effect.provide(makeTestContextLayer({ state, key: 'cart-1' })))
      // assert the result AND the State transition
      expect(next).toBe(43)
      expect(state.get('count')).toBe(43)
    }).pipe(Effect.runPromise))
})
```

`makeTestContextLayer({ handlerKind })` provides the SAME capability-marker subset
the real boundary provides per handler kind (`service` / `objectShared` /
`objectExclusive` / `workflowShared` / `workflowRun`), so a `State.set` in a
read-only handler is still a compile error. `makeTestContext(options)` is the
lower-level form (returns the fake `ctx` + the State `Map` + the `run` journal).

**This is NOT a substitute for `RestateTestHarness`.** It deliberately does not
model durability/replay, single-writer/per-key concurrency, or cross-handler /
cross-invocation effects (`Restate.call`/`send`/`reschedule`/delayed self-send/
`pollLoop`, durable promises resolved by another invocation) — none of those route
anywhere without a server. Use the harness for any of those; use the in-memory
context for fast handler-logic and State-transition tests.

### Test ergonomics

`withRestateServer({ services, appLayer })` collapses the manual
`beforeAll`/`afterAll` scope/ingress boilerplate into `setup`/`teardown` + a
`harness()` accessor — for a suite that holds ONE native server across plain
`async` test bodies (prefer `@effect/vitest`'s `it.layer` for `it.effect` suites):

```ts
const held = withRestateServer({ services: [CounterLive], appLayer: Layer.empty })
beforeAll(held.setup, 90_000)
afterAll(held.teardown, 90_000)
// ... in a test:
const result = await Effect.runPromise(held.harness().ingress.objectCall(CounterObj, 'k', 'add', 1))
```

Under `@effect/vitest`'s `it.effect`, a bare `Effect.sleep` runs on a virtual
`TestClock` and never advances — a real-time wait coordinating with the native
server across suspend/resume would hang. `./testing` exports `liveSleep(millis)`
(an `Effect.sleep` pinned to a live `Clock`) and `withLiveClock(effect)` so
wall-clock waits actually elapse.

## API reference

### `.` (core)

| Symbol                                                                                                                                                                                                          | What                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `RestateService.{contract, implement, define}`                                                                                                                                                                  | author a stateless Service                                                             |
| `RestateObject.{contract, implement}`                                                                                                                                                                           | author a keyed Virtual Object (typed State, exclusive/shared)                          |
| `RestateWorkflow.{contract, implement}`                                                                                                                                                                         | author a Workflow (one `run`, signals, queries)                                        |
| `State.for(schemas)`                                                                                                                                                                                            | typed, capability-gated State combinators (`get`/`set`/`clear`/`clearAll`/`stateKeys`) |
| `DurablePromise.for(schema)`                                                                                                                                                                                    | typed durable-promise combinators (`get`/`peek`/`resolve`/`reject`/`getDescriptor`)    |
| `Awakeable.{make, resolve, reject}`                                                                                                                                                                             | typed external-completion tokens                                                       |
| `Restate.{run, sleep, timeout, all, race, any}`                                                                                                                                                                 | durable steps, timers, and deterministic concurrency                                   |
| `Restate.{runDescriptor, sleepDescriptor}`                                                                                                                                                                      | descriptors for `all`/`race`/`any`/`timeout`                                           |
| `Restate.{call, send, objectClient, objectSendClient, workflowClient, workflowSubmit}`                                                                                                                          | in-handler service-to-service clients                                                  |
| `Restate.reschedule({ contract, method, input, delayMillis })`                                                                                                                                                  | typed durable self-send (re-arm a keyed handler after a delay)                         |
| `RestateScheduled.make(config)` / `Restate.pollLoop`                                                                                                                                                            | a narrow durable recurring-loop Virtual Object (`fixedDelay`, `start`/`stop`/`status`) |
| `RestateScheduled.{Schedule, OnCycleError}`                                                                                                                                                                     | the loop's schedule (`fixedDelay`) + error-policy (`skipToNext`/`stopLoop`) builders   |
| `Restate.key`                                                                                                                                                                                                   | the current Object/Workflow invocation key (`ObjectKey`)                               |
| `Restate.{cancel, onCancellation}`                                                                                                                                                                              | cancel another invocation; observe this one's cancellation                             |
| `Restate.{terminal, retryable, serde, idempotencyKey, retention, sensitive, redacted}`                                                                                                                          | Schema annotations                                                                     |
| `layer(opts)` / `serve(opts)`                                                                                                                                                                                   | the scoped endpoint Layer / long-lived entrypoint                                      |
| `RestateIngress` + `call`/`callTyped`/`objectCall`/`objectCallTyped`/`objectSend`/`workflowSubmit`/`workflowAttach`/`workflowOutput`/`workflowCall`/`result`/`ingressResolveAwakeable`/`ingressRejectAwakeable` | the typed external ingress client                                                      |
| `decodeTerminalError` / `decodeErrorWith`                                                                                                                                                                       | re-decode a terminal body into the tagged error                                        |
| `RestateError`                                                                                                                                                                                                  | the wrapper's own tagged failure (`reason` discriminator)                              |
| `RestateRedaction` / `aesGcmRedactionLayer` / `aesGcmCipher` / `RedactionCipherMissingError`                                                                                                                    | field-level redaction cipher                                                           |
| `effectSerde` / `ingressSerde` / `internalSerde`                                                                                                                                                                | the Schema ↔ Restate `Serde` bridge                                                    |
| `RestateContext`, `StateRead`, `StateWrite`, `ObjectKey`                                                                                                                                                        | capability-marker Tags (appear in handler `R`)                                         |

### `./otel`

| Symbol                                  | What                                                                |
| --------------------------------------- | ------------------------------------------------------------------- |
| `RestateOtel.layer(config)`             | the shared `TracerProvider` + (opt-in) `MeterProvider` Layer        |
| `RestateOtel.withOtel(endpointOptions)` | attach hook + inbound bridge + boundary observer to every handler   |
| `RestateOtel.hook` / `inboundBridge`    | the per-service / per-invocation TRACE seams (compose by hand)      |
| `RestateOtel.boundaryObserver`          | the per-invocation span-attribute stamper (identity + error class)  |
| `restate_*` metric definitions          | the auto baseline Effect `Metric`s (re-exported for inspection)     |
| `isReplaying`                           | replay-state flag (version-fragile; prefer `Restate.run`)           |

`Restate.annotateSpan(attrs)` (on the core `Restate` namespace) is the user
span-attribute path.

### `./testing`

| Symbol                                                         | What                                                                        |
| -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `RestateTestHarness.layer(opts)`                               | the scoped native-server harness Layer                                      |
| `RestateTestHarness`                                           | the harness service (`ingress`, `stateOf`, `ingressUrl`, `adminUrl`)        |
| `withRestateServer(opts)`                                      | manual-scope harness holder (`setup`/`teardown`/`harness()`)                |
| `makeTestContext` / `makeTestContextLayer`                     | the FAITHFUL in-memory `RestateContext` for server-free handler-logic tests |
| `liveSleep` / `withLiveClock`                                  | live-clock test utils (real-time waits under `it.effect`'s `TestClock`)     |
| `serverAvailable`                                              | whether a native `restate-server` binary is on `$PATH`                      |
| `StateProxy` / `BoundIngress`                                  | the typed `stateOf` proxy / pre-bound ingress surface types                 |
| `TestContextOptions` / `TestHandlerKind` / `HeldRestateServer` | the in-memory-context + holder option/result types                          |

## How the examples are verified

The [`examples/`](./examples) directory holds runnable `.ts` files (covered by the
package `tsconfig` and `dt ts:check`). `src/examples.integration.test.ts` imports
the example contracts/impls and drives them through the `./testing` harness
against a real native `restate-server`, so `dt check:all` both type-checks every
snippet and runs the documented behavior end-to-end. A doc example that does not
compile or run is treated as a defect.

## Further reading

- [docs/vrs/vision.md](./docs/vrs/vision.md) — why this exists; what it is and is not.
- [docs/vrs/spec.md](./docs/vrs/spec.md) — the full design (boundary, capability model,
  serde, error boundary, determinism, retry, endpoint, clients, OTel, testing).
- [docs/vrs/decisions/](./docs/vrs/decisions) — the hard-to-reverse design decisions.
- [docs/vrs/glossary.md](./docs/vrs/glossary.md) — Restate + binding vocabulary.
