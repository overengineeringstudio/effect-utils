# Durable steps, calls, and awakeables

[← Handbook index](./README.md)

## `Restate.run` — the durable side-effect step

`Restate.run(name, effect, options?)` journals its result so later attempts replay
it instead of re-executing. Put any side effect or raw nondeterminism inside a
`run`: it runs once on real execution, and a replay reads the journaled value
verbatim.

```ts
const id = yield* Restate.run('gen-id', Effect.sync(() => crypto.randomUUID()))
```

- The `name` is **load-bearing** for trace identity and journal labeling — prefer
  distinct names per step (duplicate names are legal but trace-confusing).
- `options` surfaces Restate's per-step retry/backoff controls (`maxRetryAttempts`,
  `maxRetryDuration`, intervals, factor). **Never** wrap a durable step in
  `Effect.retry` — that double-retries non-durably. Durable retries are Restate's;
  see [Annotations](./annotations.md#retry-and-timeout-knobs) and the
  [retry decision](../vrs/decisions/0006-restate-owns-retries.md).
- Inside a `run` closure, a nested `ctx.*` / `State.*` / `Restate.sleep` is a
  **compile error** (the durable capabilities are scrubbed) — mirroring Restate's
  "no nested `ctx.*` inside `run`" rule.

`Restate.run` has a **clean `E`**: only the inner effect's own domain `E` flows
through, and a durable-op infra failure is a defect at the boundary. See the
[error boundary](./schema-and-errors.md#clean-error-channel-infra-failures-are-defects-not-typed-e).

### `Restate.runExit` — observe the outcome

`Restate.runExit(name, effect)` returns `Effect<Exit<A, E>>` so you can branch on
success / domain failure / infra die and run a compensating durable step — the
saga building block. See
[the error boundary](./schema-and-errors.md#observing-a-durable-steps-outcome-sagas).

## In-handler service-to-service clients

In-handler clients invoke another construct from inside a handler, typed from the
**target** contract. `Restate.call` is request/response (durably journaled — a
caller crash recovers the result rather than re-issuing); `Restate.send` is one-way
(optionally delayed — a durable, fault-tolerant cron). The full file is
[`examples/07-clients-idempotency-awakeables.ts`](../../examples/07-clients-idempotency-awakeables.ts).

```ts
// request/response to another Service, typed from `Greeter`'s contract
const greeting = yield* Restate.call(Greeter, 'greet', { name }).pipe(Effect.orDie)
// one-way send; the idempotency key is read off `requestId` automatically
yield* Restate.send(Notifier, 'notify', { requestId: `welcome-${name}`, body: greeting.message }).pipe(Effect.orDie)
// a delayed one-way send — a durable, fault-tolerant timer
yield* Restate.send(Notifier, 'notify', { requestId: `reminder-${name}`, body: 'still there?' }, { delayMillis: 60_000 }).pipe(Effect.orDie)
```

The full surface on the `Restate` namespace:

| Combinator | Target | Shape |
| --- | --- | --- |
| `Restate.call` | Service | request/response |
| `Restate.send` | Service | one-way (optionally `{ delayMillis }`) |
| `Restate.objectClient` | Virtual Object | request/response (keyed) |
| `Restate.objectSendClient` | Virtual Object | one-way (keyed) |
| `Restate.workflowClient` | Workflow | signal/query |
| `Restate.workflowSubmit` | Workflow | submit the `run` |

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
const { id, promise } = yield* Awakeable.make(Payload)
yield* Waiter.set('awakeableId', id) // persist `id`, hand it to the external system
const payment = yield* promise // durably suspends until resolved

// from ingress (or another handler):
yield* ingressResolveAwakeable(Payload, id, { token: 'ok' })
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
const { id, promise, descriptor } = yield* Awakeable.make(Schema.String)
// resume on EITHER the external completion OR a durable deadline — replay-stable
const winner = yield* Restate.race([
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
