# Durable steps, calls, and awakeables

[← Handbook index](./README.md)

## `Restate.run` — the durable side-effect step

`Restate.run(name, effect, options?)` journals its result so later attempts replay
it instead of re-executing. Put any side effect or raw nondeterminism inside a
`run`: it runs once on real execution, and a replay reads the journaled value
verbatim.

```ts
const id =
  yield *
  Restate.run(
    'gen-id',
    Effect.sync(() => crypto.randomUUID()),
  )
```

- The `name` is **load-bearing** for trace identity and journal labeling — prefer
  distinct names per step (duplicate names are legal but trace-confusing).
- `options` surfaces Restate's per-step retry/backoff controls (`maxRetryAttempts`,
  `maxRetryDuration`, intervals, factor). **Never** wrap a durable step in
  `Effect.retry` — that double-retries non-durably. Durable retries are Restate's;
  see [Annotations](./annotations.md#retry-and-timeout-knobs) and the
  [retry decision](../vrs/.decisions/0006-restate-owns-retries.md).
- Inside a `run` closure, a nested `ctx.*` / `State.*` / `Restate.sleep` is a
  **compile error** (the durable capabilities are scrubbed) — mirroring Restate's
  "no nested `ctx.*` inside `run`" rule.
- `Restate.run` takes an **Effect**. Its descriptor sibling
  `Restate.runDescriptor(name, action)` (for `all` / `race` / `any` /
  `timeout`) instead takes a **thunk** `() => Promise<A>` (or `() => A`) that
  **returns a Promise** — a descriptor is issued synchronously, so it cannot take
  an Effect. Passing an `Effect` where a `() => Promise` is expected is the common
  first-time descriptor compile error. See
  [Determinism](./determinism.md#deterministic-concurrency-takes-descriptors).

`Restate.run` has **no catchable typed failure**: its inner effect is
`Effect<A, never, R>` and `run` returns `Effect<A, never, …>`. A durable-op infra
failure is a defect at the boundary; domain errors belong in the handler body (or are
encoded as values in the step), and to force a durable retry you **die** inside the
step. See the
[error boundary](./schema-and-errors.md#clean-error-channel-infra-failures-are-defects-not-typed-e).

### `Restate.runExit` — observe the outcome

`Restate.runExit(name, effect)` returns `Effect<Exit<A>>` so you can branch on
success vs an infra-die / interrupt `Cause` and run a compensating durable step — the
saga building block (the failure channel is `never`; a durable step has no typed
domain `E`). See
[the error boundary](./schema-and-errors.md#observing-a-durable-steps-outcome-sagas).

## In-handler service-to-service clients

In-handler clients invoke another construct from inside a handler, typed from the
**target** contract. `Restate.call` is request/response (durably journaled — a
caller crash recovers the result rather than re-issuing); `Restate.send` is one-way
(optionally delayed — a durable, fault-tolerant cron). The full file is
[`examples/07-clients-idempotency-awakeables.ts`](../../examples/07-clients-idempotency-awakeables.ts).

```ts
// request/response to another Service, typed from `Greeter`'s contract
const greeting = yield * Restate.call(Greeter, 'greet', { name }).pipe(Effect.orDie)
// one-way send; the idempotency key is read off `requestId` automatically
yield *
  Restate.send(Notifier, 'notify', { requestId: `welcome-${name}`, body: greeting.message }).pipe(
    Effect.orDie,
  )
// a delayed one-way send — a durable, fault-tolerant timer
yield *
  Restate.send(
    Notifier,
    'notify',
    { requestId: `reminder-${name}`, body: 'still there?' },
    { delayMillis: 60_000 },
  ).pipe(Effect.orDie)
```

The full surface on the `Restate` namespace:

| Combinator                 | Target         | Shape                                  |
| -------------------------- | -------------- | -------------------------------------- |
| `Restate.call`             | Service        | request/response                       |
| `Restate.send`             | Service        | one-way (optionally `{ delayMillis }`) |
| `Restate.objectClient`     | Virtual Object | request/response (keyed)               |
| `Restate.objectSendClient` | Virtual Object | one-way (keyed)                        |
| `Restate.workflowClient`   | Workflow       | signal/query                           |
| `Restate.workflowSubmit`   | Workflow       | submit the `run`                       |

These require `RestateContext` (handler-only) and carry a typed `RestateError`.

### Idempotency

Idempotency is declared once on the input field via `Restate.idempotencyKey` — the
single source. The client reads the key off that field; there is no call-site option
to keep in sync.

```ts
const NotifyInput = Schema.Struct({
  requestId: Restate.idempotencyKey(Schema.String), // this field's value IS the key
  body: Schema.String,
})
```

Idempotency keys dedupe across calls/sends; the send's output is retained and
attachable via `result` once the invocation completes.

### End-to-end idempotency: one identity across the layers

Deduplication is only as good as the **identity** you thread through it. A real
pipeline crosses several constructs — a producer emits an intent, a Virtual Object
records an incident, a Workflow drives a long-running delivery — and each layer has
its own notion of "key". The discipline: derive **one logical identity** from the
producer's intent and reuse the **same string** at every layer, so a re-submitted
intent dedupes end-to-end instead of forking a second pipeline.

```
producer intent-id  "intent-42"
        │  (the single source — the producer's natural request id)
        ▼
Virtual-Object key  objectCall(IncidentObj, "intent-42", "open", …)   ← incident key
        ▼
Workflow id         Restate.workflowSubmit(DeliveryWf, "intent-42", …) ← workflow id
        ▼
delivery send       Restate.idempotencyKey field = "intent-42"        ← send dedupe key
```

The **single source** is the producer's intent-id. `Restate.idempotencyKey` declares
it once on the input field that carries it; every downstream layer keys off that same
value:

```ts
const DeliverInput = Schema.Struct({
  intentId: Restate.idempotencyKey(Schema.String), // the ONE identity, declared once
  body: Schema.String,
})

// All four layers key off the SAME `intentId` string:
yield * Restate.objectSendClient(IncidentObj, intentId, 'open', { note }) // VO key = intentId
yield * Restate.workflowSubmit(DeliveryWf, intentId, payload) // workflow id = intentId (idempotent submit)
yield * Restate.send(Notifier, 'deliver', { intentId, body }) // send dedupe key = intentId
```

A re-submitted `intent-42` then hits the SAME incident key, the SAME workflow id
(`workflowSubmit` is idempotent — a second submit attaches to the running one rather
than starting a new run), and the SAME send key — so the whole pipeline dedupes.

**The misuse to avoid:** minting a _fresh_ key at each layer (a new UUID per send, a
random workflow id), or keying a downstream layer off a _derived_ value that is not
stable across a retry (a timestamp, a `crypto.randomUUID()` outside `Restate.run`).
Different keys at different layers means a re-submitted intent **forks** — a second
incident, a second workflow run, a duplicate delivery — which is the exact bug
idempotency was meant to prevent. Thread the one producer identity all the way down.

## Awakeables — external completion tokens

An **awakeable** is a typed external-completion token. A handler creates one, hands
its `id` to an external system, and suspends on its `promise` until the external
system resolves it (in-handler via `Awakeable.resolve`, or from ingress via
`ingressResolveAwakeable`). The awakeable round-trip is verified end-to-end in
[`examples/07-clients-idempotency-awakeables.ts`](../../examples/07-clients-idempotency-awakeables.ts).

```ts
import { Awakeable } from '@overeng/restate-effect'

const Payload = Schema.Struct({ token: Schema.String })

// in a handler:
const { id, promise } = yield * Awakeable.make(Payload)
yield * Waiter.set('awakeableId', id) // persist `id`, hand it to the external system
const payment = yield * promise // durably suspends until resolved

// from ingress (or another handler):
yield * ingressResolveAwakeable(Payload, id, { token: 'ok' })
```

`Awakeable.make` returns `{ id, promise, descriptor }`. The `id` is branded and
typed by the payload Schema; `promise` is itself an `Effect` that suspends until
resolution; `descriptor` lets the awakeable join a deterministic race (next).

### Awakeables (and other durable ops) in a deterministic race

Every durable op exposes a **descriptor** so it joins `Restate.all` / `race` / `any`
deterministically — issued in journal-source order, awaited once. This includes
durable promises (`DurablePromise.for(S).getDescriptor`), in-handler calls
(`Restate.callDescriptor` / `objectCallDescriptor`), and awakeables
(`Awakeable.make(S).descriptor`). See
[`examples/05-determinism.ts`](../../examples/05-determinism.ts) (`awakeableRaceExample`).

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

This replaces the in-process `Effect.raceFirst` workaround, which loses
journal-order determinism (that was the bug). See [Determinism](./determinism.md)
for the descriptor model in full.

## See also

- [Determinism](./determinism.md) — journaled Clock/Random, durable waits, descriptors, lints.
- [Schema I/O and the typed error boundary](./schema-and-errors.md) — the clean `E` and `runExit`.
- [Self-reschedule and durable scheduling](./scheduling.md) — delayed self-sends as durable daemons.
