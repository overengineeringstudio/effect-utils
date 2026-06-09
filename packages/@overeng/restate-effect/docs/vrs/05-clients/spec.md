# Spec: 05-clients

Specifies the typed clients derived from a contract: the external ingress client
(idempotency / attach / output / awakeable resolution) and in-handler
service-to-service clients. Builds on
[../requirements.md](../requirements.md) + [./requirements.md](./requirements.md);
terms in [../glossary.md](../glossary.md); rationale in
[../.decisions/](../.decisions/). See [../spec.md](../spec.md) for the index.

Traces: R10, R14, R32, R33. See
[../.decisions/0008](../.decisions/0008-typed-client-inference.md). From a contract
alone (no hand-declared handler shape), the binding derives fully typed clients.

## 1. External ingress client

`@restatedev/restate-sdk-clients`'s ingress wrapped as an Effect service:

```ts
const ingress = yield * RestateIngress
const result = yield * ingress.call(Greeter, 'greet', { name: 'Sarah' })
//    result : GreetSuccess          (Schema-validated args + typed success)

// typed error decode (R14): re-decode the terminal body into the tagged error
yield *
  ingress
    .call(Greeter, 'greet', { name: '' })
    .pipe(Effect.catchTag('EmptyName', () => Effect.succeed(fallback)))
```

Arguments are encoded through the contract's input serde; the result is decoded
through the success serde; a `TerminalError` body is re-decoded through the error
serde into the original tagged error so the caller `catchTag`s it rather than a
raw transport error (R14, see
[04-error-boundary](../04-error-boundary/spec.md#error-boundary)). Cross-language
callers get the encoded JSON body plus `_tag` only (T06).

A handler whose contract sets `ingressPrivate: true` is NOT callable from the
ingress client — the client TYPE omits it (R35), so an ingress-private handler
call is a compile error, not a runtime rejection.

### 1.1 Idempotency, attach, and output

```ts
// idempotency key from the annotated input field (0011), not a call-site option
const handle = yield * ingress.send(Notifier, 'notify', { key: 'abc-123', body })

// attach / result: get-output by invocation id OR idempotency key
const out = yield * ingress.result(Notifier, 'notify', { idempotencyKey: 'abc-123' })
//    out : NotifySuccess | <decoded terminal error>

// workflow ingress surface: submit / attach / output (run is NOT directly callable)
const sub = yield * ingress.submit(Onboard, 'wf-1', input) // WorkflowSubmission
const result = yield * ingress.attach(Onboard, 'wf-1') // typed success | decoded error
```

The idempotency key is the value of the input field carrying the
`Restate.idempotencyKey` annotation — the SINGLE source; the call-site
`{ idempotencyKey }` send option is dropped
([../.decisions/0011](../.decisions/0011-restate-schema-annotations.md); see
[02-schema-serde](../02-schema-serde/spec.md#schema-annotation-namespace)).
`attach` / `result` resolve a running invocation by invocation id OR idempotency
key and return the typed success or the DECODED terminal error (same decode helper
as R14). For a Workflow, the ingress surface is `submit` / `attach` / `output`; the
`run` handler is OMITTED from the direct call surface (R32).

### 1.2 Awakeable external completion

```ts
// in a handler:
const { id, promise } = yield * Awakeable.make(PaymentResult) // id branded, typed payload
const payment = yield * promise // `promise` is itself an Effect; suspends until resolved

// from ingress (or another handler):
yield * ingress.resolveAwakeable(id, payment) // typed via payload serde
yield * ingress.rejectAwakeable(id, 'declined')
```

`Awakeable.make` returns a typed `{ id, promise }` with the id branded; the
payload is serialized via the payload serde. Resolution may come from an
in-handler caller OR from ingress (R33). See the glossary note.

The `promise` await — like the blocking `DurablePromise.get`/`peek` — routes
through the SAME `awaitDurable` seam as `run`/`sleep`, so it classifies a rejection
identically: a suspension PARKS the invocation, a cancellation INTERRUPTS, and a
`reject` (`ingress.rejectAwakeable` / `Awakeable.reject` / `DurablePromise.reject`)
terminalizes the awaiter VERBATIM (R33/R34) — the awaiting handler fails terminally,
NOT as a retried `RestateError` infra defect. The typed `E` stays clean (#1, see
[04-error-boundary](../04-error-boundary/spec.md#error-boundary)).

---

## 2. In-handler service-to-service clients

`ctx.serviceClient` / `objectClient` / `workflowClient` (request/response,
suspends) and `*SendClient` (one-way) exposed as Effect combinators, typed from
the target contract:

```ts
yield * Restate.call(Greeter, 'greet', { name }) // request/response
yield * Restate.send(Notifier, 'notify', payload) // one-way (idempotency from field)
yield * Restate.send(Reminder, 'fire', payload, { delay: '60 seconds' }) // delayed
```

Idempotency keys (from the annotated input field) dedupe across calls; calls and
sends are journaled, so a caller crash recovers the result from the journal
rather than re-issuing. A keyed durable SELF-SEND (`Restate.reschedule`) is built
on the delayed-send primitive — see [06-scheduling](../06-scheduling/spec.md).
