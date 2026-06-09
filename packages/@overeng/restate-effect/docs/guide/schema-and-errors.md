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
**no** `RestateError`. A durable `Restate.run` step goes further: it carries **no
catchable typed failure at all** — its inner effect is `Effect<A, never, R>` and
`run` returns `Effect<A, never, …>`. The inner runs via `Runtime.runPromise` inside
`ctx.run`, so a typed `Effect.fail` would only _reject_ the step (Restate retries; a
give-up becomes a `RestateError` defect) and never reach the outer failure channel.
Domain errors therefore belong in the **handler body** (classify the step's result
there) or are encoded as **values** inside the step; to force a durable retry, **die**
inside the step. A durable-op infrastructure failure is classified at the boundary as
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

## Worked recipe: classifying real HTTP outcomes

A handler that calls an upstream HTTP API has to decide, per response, which channel
each outcome belongs in — and the **journal makes two transient-retry strategies
genuinely different**, which is a real consumer footgun. The full, end-to-end
verified file is
[`examples/14-http-error-classification.ts`](../../examples/14-http-error-classification.ts).

The error union is a realistic mix of terminal and retryable members:

| HTTP outcome              | Channel                            | Why                                             |
| ------------------------- | ---------------------------------- | ----------------------------------------------- |
| 400 / 403 / 404           | terminal domain error (`E`)        | deterministic; a retry returns the same answer  |
| 200 but body ≠ schema     | terminal `MalformedUpstream` (`E`) | the same broken bytes fail identically on retry |
| 429 / 5xx / network error | a retry might succeed (TRANSIENT)  | the upstream may recover                        |

**The terminal members are easy:** map the status to a typed `Schema.TaggedError`
in the handler body (`Restate.terminal(Err, { errorCode })`) so it crosses the wire
and the caller `catchTag`s it. A `Widget` decode mismatch on a 200 is terminal too —
distinct from a transient 5xx.

**The transient member is where the journal bites.** A `Restate.run` step is
journaled, so if you classify a 429 into a _committed_ `run` outcome, a handler-level
retry **replays the stale 429 forever** instead of re-fetching (verified — that is
the footgun). There are two loop-free strategies, and the example shows both:

1. **Ride Restate's durable step retry** (recommended for an idempotent read). Put
   the fetch in `Restate.run` and **fail the step** on a transient (e.g.
   `Effect.die`), so it is _not_ committed — Restate re-runs the step (re-fetching)
   with backoff. A definitive 2xx / 4xx-terminal outcome commits. A 429-then-200
   upstream then succeeds because the step re-executes.

2. **Surface a caller-visible `retryable` error** (when you want the _whole_
   invocation parked in `backing-off`, operator-visible per
   [Admin operations](./admin-operations.md)). Classify the live response in the
   **handler body** — _not_ a committed `run` — and fail with the
   `Restate.retryable` `UpstreamUnavailable`, with the 429's `Retry-After` **projected**
   onto it (see [Annotations](./annotations.md#retryable-errors-and-retryafter)).
   Because the transient response is never journaled, a handler retry re-fetches.

The rule of thumb: **a journaled `run` is for a step whose result is final.** A
transient outcome is not final, so either fail the step (strategy 1) or keep the
classification out of the journal (strategy 2) — never commit a transient and then
retry against it.

## Observing a durable step's outcome (sagas)

To **observe** a durable step's outcome (for compensation / sagas) instead of
letting a failure propagate, use `Restate.runExit(name, effect)` → `Effect<Exit<A>>`.
The `Exit` faithfully captures the observed outcome: `Exit.succeed(A)`, or an
`Exit.failure(Cause)` for an infra give-up (a `Cause.Die` carrying the `RestateError`,
via `Cause.dieOption`) or an interruption (a `Cause.Interrupt`). The failure channel
is `never` — a durable step has no typed domain `E`, so an observed failure is always
a defect/interrupt you branch on, then run a compensating durable step without the
failure escaping.

```ts
const outcome = yield * Restate.runExit('charge', chargeCard) // chargeCard : Effect<ChargeReceipt>
// outcome : Exit<ChargeReceipt, never>
// branch on success vs an infra-die / interrupt Cause, then run a compensating step
```

## See also

- [Annotations and redaction](./annotations.md) — per-error status codes, retryable, retryAfter, redaction.
- [Durable steps](./durable-steps.md) — `Restate.run` / `runExit`, awakeables, in-handler calls.
- [The three constructs](./constructs.md) — where State and I/O schemas are declared.
