# The three constructs

[← Handbook index](./README.md)

Restate offers three constructs. The binding exposes each as a `contract` +
`implement` pair (see [Authoring](./authoring.md) for the shared mechanics).

| Construct      | Key             | State          | Concurrency                                     |
| -------------- | --------------- | -------------- | ----------------------------------------------- |
| Service        | none            | none           | unbounded                                       |
| Virtual Object | per key         | typed, durable | exclusive serialized per key; shared concurrent |
| Workflow       | per workflow ID | typed, durable | one `run` exactly-once; signals concurrent      |

Pick the narrowest one that fits: a Service if you need no per-key state, a Virtual
Object for keyed durable state with serialized writes, a Workflow when one
long-lived `run` coordinates signals/queries through durable promises.

## Service (stateless)

A Service has no key and no State; invocations are unbounded and concurrent. This
is the construct from [Getting started](./getting-started.md). The full file is
[`examples/01-service.ts`](../../examples/01-service.ts).

```ts
const Greeter = RestateService.contract('greeter', {
  greet: { input: GreetInput, success: GreetSuccess, error: EmptyName },
})

const GreeterLive = RestateService.implement<typeof Greeter, Greeting>(Greeter, {
  greet: ({ name }) =>
    Effect.gen(function* () {
      if (name === '') return yield* new EmptyName()
      const { prefix } = yield* Greeting
      const id = yield* Restate.run(
        'gen-id',
        Effect.sync(() => crypto.randomUUID()),
      )
      return { message: `${prefix} ${name}`, id }
    }),
})
```

## Virtual Object (keyed, typed State)

A Virtual Object is keyed and holds typed, durable State. Handlers are **exclusive**
by default (serialized per key, full State access) or `shared: true` (concurrent,
read-only State). Writing State in a shared handler is a **compile error**.

The `state` block is the single source of truth for State keys and value Schemas;
`State.for(stateBlock)` gives you the typed, capability-gated combinators. The full
file is [`examples/02-virtual-object.ts`](../../examples/02-virtual-object.ts).

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
    }),
  // A `Counter.set(...)` in this shared handler would NOT type-check.
  get: () => Counter.get('count').pipe(Effect.map((c) => c ?? 0)),
})
```

### The exclusive/shared distinction

| Handler kind        | Capabilities provided                    | State writes                         |
| ------------------- | ---------------------------------------- | ------------------------------------ |
| exclusive (default) | `ObjectKey` + `StateRead` + `StateWrite` | allowed; serialized per key          |
| `shared: true`      | `ObjectKey` + `StateRead`                | a `State.set` is a **compile error** |

The capability markers are flat services in the handler's `R` channel. A shared
handler is simply never given `StateWrite`, so the illegal write is unrepresentable
rather than checked at runtime. `State.get` returns `value | undefined` (undefined =
unset), so default it.

### Nullable State (optional fields)

State is a per-key key/value map, so an absent key reads back as `undefined`. To
model a NULLABLE cursor (e.g. a `highWatermark` you may not have set yet), declare
the field `Schema.optional`:

```ts
const Cursor = State.for({ highWatermark: Schema.optional(Schema.Number) })

const wm = yield * Cursor.get('highWatermark') // number | undefined (undefined = absent)
yield * Cursor.set('highWatermark', 42) // set a present value
yield * Cursor.set('highWatermark', undefined) // clears the key (≡ State.clear)
yield * Cursor.clear('highWatermark') // also clears it
```

Writing `undefined` REMOVES the key rather than storing a present-but-`undefined`
value — read and write are symmetric around "absent ⇒ undefined". This is the one
pattern that type-checks under both the compiler and the bundler; a bare top-level
`Schema.UndefinedOr` handler RETURN does not (it has no JSON schema), so keep a
nullable value in State or inside a struct field, not as a top-level handler output.
The same `set`/`get`/`clear` semantics are available on the test `stateOf` proxy
(`RestateTestHarness.stateOf` / `RestateTestEnv.stateOf`).

### Keying and the key accessor

Call a keyed handler with the per-invocation key as the second argument:
`objectCall(CounterObj, 'cart-1', 'add', 3)`. State is isolated per key.

Inside a handler, `Restate.key` reads the current invocation key (it requires the
`ObjectKey` capability, so it is available in any Object/Workflow handler).

## Workflow (one `run`, durable promises)

A Workflow has one `run` handler that executes exactly-once per workflow ID, plus
`signal` and `query` shared handlers. The `run` handler owns the full capability
set; signals/queries are shared (read-only State) and may resolve/await durable
promises.

A **durable promise** is the rendezvous between `run` (which awaits it) and a signal
(which resolves it) — the await is journaled, so it survives process restarts. The
full file is [`examples/03-workflow.ts`](../../examples/03-workflow.ts).

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
    }),
  approve: () => Approval.resolve('decision', { approved: true }), // signal
  status: () => Status.get('status').pipe(Effect.map((s) => s ?? 'pending')), // query
})
```

The capabilities per handler kind:

| Handler kind             | Capabilities provided                                       |
| ------------------------ | ----------------------------------------------------------- |
| `run`                    | `ObjectKey` + `StateRead` + `StateWrite` + `DurablePromise` |
| `signal` (shared, write) | `ObjectKey` + `StateRead` + `DurablePromise`                |
| `query` (shared, read)   | `ObjectKey` + `StateRead` + `DurablePromise`                |

A durable promise supports `get` / `resolve` / `reject` / `peek` /
`getDescriptor`. A `reject` arrives terminally and can drive a `'rejected'` State
path observable via a query.

The durable-promise **key** (`'decision'` above) is a free-form string **you**
choose to name the rendezvous; it is **distinct** from the signal handler name
(`approve`). The `run` handler awaits `Approval.get('decision')` and the `approve`
signal resolves `Approval.resolve('decision', …)` — they meet because they use the
**same key string**, not because the handler is named `approve`. Pick any key; just
keep the awaiting `get` and the resolving `resolve` on the same one.

### The Workflow ingress surface

The Workflow ingress surface is `workflowSubmit` / `workflowAttach` /
`workflowOutput` plus `workflowCall` (signals/queries); the `run` handler is **not**
directly callable (you submit it, you do not call it). See
[`examples/06-ingress-client.ts`](../../examples/06-ingress-client.ts).

```ts
import { Effect } from 'effect'
import { workflowAttach, workflowCall, workflowSubmit } from '@overeng/restate-effect'

const run = Effect.gen(function* () {
  yield* workflowSubmit(ApprovalWf, 'wf-1', 'please review') // idempotent; returns at once
  yield* workflowCall(ApprovalWf, 'wf-1', 'approve', undefined) // a signal
  return yield* workflowAttach(ApprovalWf, 'wf-1') // awaits the run's typed success
}).pipe(Effect.provide(IngressLayer))
```

## See also

- [Authoring](./authoring.md) — `contract`/`implement`/`define` and the typed clients.
- [Schema I/O and the typed error boundary](./schema-and-errors.md) — how State and I/O are serialized.
- [Durable steps](./durable-steps.md) — `Restate.run`, awakeables, in-handler calls.
