# Schema I/O and the typed error boundary

[← Handbook index](./README.md)

Every Restate-managed value — handler input/output, State, `Restate.run` results,
awakeable payloads, durable promises, ingress — is governed by a serde built from
an Effect `Schema`. The serde bridges `Schema<A, I>` to a Restate `Serde<A>`:
encode is `Schema.encode` then `JSON.stringify`; decode is `JSON.parse` then
`Schema.decode`.

## Decode failures are classified by slot

A `ParseError` on decode is classified by the **slot** it failed in:

- an **ingress** input slot → `TerminalError(400)` (a malformed request is a
  deterministic bad request; retrying cannot help);
- an **internal** slot (State, journal, payloads) → a **defect** Restate retries (a
  decode failure there is a corrupt journal, not the current caller's fault — a 400
  to the current caller would be wrong).

One `effectSerde` governs every slot of a given type; only the classification of a
decode failure differs. Serdes are built once per contract/`materialize` and
memoized, not rebuilt per durable op.

## The error channel means one thing

A handler's `E` channel carries **only** its declared business errors. They cross
the wire as terminal errors and decode back into the original tagged error on the
caller side, so callers `catchTag` typed domain errors.

The binding's own bridge failures (`Restate.run`/serde/endpoint/ingress) are a
single tagged `RestateError`, defects by default, that Restate retries — they never
enter your domain channel.

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

The boundary **validates** a thrown domain failure against the contract's declared
`error` union before encoding it. A failure that does not match the declared union
is classification drift — surfaced as a defect (so the SDK retries and the bug is
visible) rather than mis-encoding garbage into the terminal body.

## The typed terminal decode (caller side)

The ingress decode helper (`callTyped` / `objectCallTyped` / `workflowAttach`)
reverses the transport: it parses the terminal body and re-decodes it back into the
original tagged error, so the caller `catchTag`s a typed domain error. `call` /
`objectCall` leave the raw transport `RestateError` if you prefer to handle it. See
[`examples/06-ingress-client.ts`](../../examples/06-ingress-client.ts).

```ts
// An empty name fails the handler with `EmptyName`, which crosses the wire as a
// terminal error and is decoded back into the tagged `EmptyName` here.
export const greetWithRecovery = callTyped(Greeter, 'greet', { name: '' }).pipe(
  Effect.map((ok) => ok.message),
  Effect.catchTag('EmptyName', () => Effect.succeed('(no name given)')),
  Effect.provide(IngressLayer),
)
```

`decodeTerminalError` / `decodeErrorWith` are the standalone forms for re-decoding a
terminal body when you already hold a raw `RestateError`.

## Clean error channel: infra failures are defects, not typed `E`

The durable combinators (`Restate.run` / `sleep` / `timeout` / `all` / `race` /
`any` / `State.*` / `Awakeable.make().promise`) have a **clean `E`** — they carry
**no** `RestateError`. Only the inner effect's own domain `E` flows through
`Restate.run`. A durable-op infrastructure failure is classified at the boundary as
a defect (transient infra → Restate retries; a terminally-failed step → fail, no
retry), so you never write a no-op `catchTag('RestateError', Effect.die)` to scrub
it out of a handler's typed channel.

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

This is why the verified examples ([`01-service`](../../examples/01-service.ts),
[`02-virtual-object`](../../examples/02-virtual-object.ts),
[`03-workflow`](../../examples/03-workflow.ts)) read State and run durable steps
without any `orDie` scrubbing — the `E` stays exactly the declared domain union.

> **Note on the in-handler client surface.** `Restate.call` / `send` and the ingress
> client DO carry a typed `RestateError` (it pairs with `decodeTerminalError`).
> That is the one place you handle a `RestateError` in the `E` channel — typically
> with `Effect.orDie` (an infra failure is a defect) or an explicit `catchTag`.

## Observing a durable step's outcome (sagas)

To **observe** a durable step's outcome (for compensation / sagas) instead of
letting a failure propagate, use `Restate.runExit(name, effect)` →
`Effect<Exit<A, E>>`. The `Exit` captures success, a domain `E` failure, and an
infra failure (a `Cause.Die` carrying the `RestateError`, via `Cause.dieOption`), so
you can branch and run a compensating durable step without the failure escaping.

```ts
const outcome = yield * Restate.runExit('charge', chargeCard)
// outcome : Exit<ChargeReceipt, PaymentDeclined>
// branch on success / domain failure / infra die, then run a compensating step
```

## See also

- [Annotations and redaction](./annotations.md) — per-error status codes, retryable, retryAfter, redaction.
- [Durable steps](./durable-steps.md) — `Restate.run` / `runExit`, awakeables, in-handler calls.
- [The three constructs](./constructs.md) — where State and I/O schemas are declared.
