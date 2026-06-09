# Authoring: contract, implement, define

[← Handbook index](./README.md)

A construct is authored in two parts:

- **`contract(name, specs)`** produces a typed, shareable artifact carrying handler
  names and their I/O/error Schemas in its TYPE. It has no server dependencies — a
  client package can import it to get a fully typed client without pulling the
  implementation.
- **`implement(contract, handlers)`** binds each handler name to an Effect and
  produces the server-side Layer.

```
contract ──► typed ingress client     (callers, any package)
         └─► in-handler clients        (other handlers, service-to-service)
implement ─► server-side Layer         (served by the endpoint)
```

## The explicit `AppR` discipline

`implement` takes the application requirement `AppR` as an **explicit** type
parameter — the residual requirement the application Layer satisfies. It is never
inferred from the handler bodies (inferring would over-union the per-handler
residual `R` and the capability markers would fail to collapse).

```ts
// `Greeting` is the AppR; the handler `E` channel carries only `EmptyName`.
const GreeterLive = RestateService.implement<typeof Greeter, Greeting>(Greeter, {
  greet: ({ name }) => /* … */,
})
// GreeterLive : Layer<RestateImpl<'greeter'>, never, Greeting>
```

A construct that needs no application service uses `AppR = never` (the default, so
you can omit it).

## `define` — contract + implement in one expression

For the single-package case, `RestateService.define(name, specs, impl)` combines
`contract` + `implement`. The separable `contract` artifact is still exposed (so
cross-package clients still work). See
[`examples/07-clients-idempotency-awakeables.ts`](../../examples/07-clients-idempotency-awakeables.ts).

```ts
export const Orchestrator = RestateService.define(
  'orchestrator',
  { start: { input: Schema.String, success: Schema.String } },
  {
    start: (name) =>
      Effect.gen(function* () {
        const greeting = yield* Restate.call(Greeter, 'greet', { name }).pipe(Effect.orDie)
        // … one-way and delayed sends …
        return greeting.message
      }),
  },
)
```

## The typed ingress client (external callers)

From a contract **alone** — no hand-declared handler shape — the binding derives a
fully typed client. Arguments are validated and encoded through the contract's
input serde, the result is decoded through the success serde, and a terminal error
body is re-decoded into the original tagged error. The client requires a
`RestateIngress` layer bound to the server's ingress URL. The full file is
[`examples/06-ingress-client.ts`](../../examples/06-ingress-client.ts).

```ts
import { Effect } from 'effect'
import {
  callTyped,
  objectCall,
  RestateIngress,
  workflowAttach,
  workflowSubmit,
} from '@overeng/restate-effect'

const IngressLayer = RestateIngress.layer({ url: 'http://localhost:8080' })

// A typed Service call: `result` is `{ message, id }` (validated success).
const greet = callTyped(Greeter, 'greet', { name: 'Sarah' }).pipe(Effect.provide(IngressLayer))

// A keyed Virtual Object call (the per-invocation key is the second argument).
const addToCounter = objectCall(CounterObj, 'counter-1', 'add', 3).pipe(
  Effect.provide(IngressLayer),
)
```

The ingress surface, by construct:

| Construct      | Request/response                                                     | One-way                                              | Notes                                      |
| -------------- | -------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------ |
| Service        | `call` / `callTyped`                                                 | —                                                    | `callTyped` adds the typed terminal decode |
| Virtual Object | `objectCall` / `objectCallTyped`                                     | `objectSend`                                         | key is the 2nd argument                    |
| Workflow       | `workflowCall` (signals/queries), `workflowAttach`, `workflowOutput` | `workflowSubmit`                                     | `run` is submitted, not called             |
| Awakeable      | —                                                                    | `ingressResolveAwakeable` / `ingressRejectAwakeable` | resolve an external token                  |

`call` / `objectCall` leave the raw transport `RestateError` if you prefer to handle
it yourself; `callTyped` / `objectCallTyped` / `workflowAttach` run the typed
terminal decode for you (see [the error boundary](./schema-and-errors.md)).

A handler whose contract sets `ingressPrivate: true` is omitted from the client
**type** — calling it from ingress is a compile error, not a runtime rejection.

### Idempotency, attach, and output

Idempotency is declared **once** on the input field via `Restate.idempotencyKey` —
the single source. The client reads the key off that field; there is no call-site
`{ idempotencyKey }` option to keep in sync.

```ts
const NotifyInput = Schema.Struct({
  requestId: Restate.idempotencyKey(Schema.String), // this field's value IS the key
  body: Schema.String,
})
```

`result(handle, schema)` resolves a running invocation by send-handle / idempotency
key and returns the typed success (or the decoded terminal error). For a Workflow,
`workflowAttach` / `workflowOutput` resolve the `run` outcome.

## In-handler clients (service-to-service)

Inside a handler you invoke another construct via the `Restate` namespace, typed
from the **target** contract. `Restate.call` is request/response; `Restate.send` is
one-way (optionally delayed). These are covered in detail in
[Durable steps, calls, and awakeables](./durable-steps.md).

```ts
const greeting = yield * Restate.call(Greeter, 'greet', { name }).pipe(Effect.orDie)
yield * Restate.send(Notifier, 'notify', { requestId: `welcome-${name}`, body }).pipe(Effect.orDie)
```

The in-handler clients require `RestateContext` (they only type-check inside a
handler) and carry a typed `RestateError` in their `E` channel — pair them with
`Effect.orDie` (an infra failure is a defect) or handle the `RestateError`
explicitly.

## See also

- [The three constructs](./constructs.md) — the per-construct contract shapes.
- [Schema I/O and the typed error boundary](./schema-and-errors.md) — serde + typed decode.
- [Annotations and redaction](./annotations.md) — `idempotencyKey`, `retention`, error annotations.
