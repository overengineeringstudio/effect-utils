# Error boundary: domain-only typed channel, terminal transport, infra-as-defect

The handler's Effect `E` channel carries ONLY declared domain (terminal) errors —
a `Schema.TaggedError` union the handler opts into via its `error` schema. The
boundary maps:

- Effect success → output serde → return value.
- Effect failure whose value matches the declared `error` schema →
  `restate.TerminalError`. The error is Schema-encoded into the `message` body
  (see below), with a PER-ERROR `errorCode` derived from the error's
  `terminal`/`retryable` annotation (default `500`; see
  [0011](./0011-restate-schema-annotations.md)). No retry; propagates to caller.
- A `retryable`-annotated domain error (or explicit `Restate.retryable(...)`,
  optional `retryAfter`) → non-terminal throw → Restate retries.
- Effect defect (incl. durable-combinator infrastructure failures) → rethrown →
  Restate retries, unless a service/handler `asTerminalError`-style policy
  classifies it terminal.
- A failure that does NOT match the declared `error` union (classification drift) →
  DEFECT (the squashed cause), never a silent mis-encode into the terminal body.
  The boundary validates with `Schema.encodeUnknownEither` before terminalizing.

`TerminalError(message: string, options)` has no separate body channel — the
encoded error and its `_tag` travel in the `message` BODY (a JSON string), NOT
in `metadata`. The ingress `HttpCallError` exposes only `status` +
`responseText`, so anything placed in `metadata` is invisible to ingress
callers. The R14 decode helper therefore `JSON.parse`s the `responseText` (the
message body) and re-decodes through the error serde. `metadata._tag` is
best-effort EXTRA for in-handler / server-side consumers and needs server ≥1.6;
it is never the load-bearing channel.

Serde failures are SLOT-AWARE. A `ParseError` from `effectSerde.deserialize` on
INGRESS INPUT is a deterministic bad request → `TerminalError(400)` (retrying
cannot help). A decode failure on an INTERNAL slot (a State value, a `ctx.run`
result, an awakeable / durable-promise payload) is a CORRUPT-JOURNAL
infrastructure condition → DEFECT / retry (R13), NOT a 400 — the data was
written by a previous attempt or another handler, so a 400 to the current caller
would be wrong. The serde distinguishes these via a slot tag (or two entry
points), not a single "one serde, one 400" rule.

The ingress client provides a typed decode helper that reverses the transport: it
re-`Schema.decode`s a `TerminalError` body back into the original tagged error,
so callers `catchTag` typed errors rather than handling a raw `HttpCallError`.

## Why

- Makes the typed `E` channel mean exactly one thing — "terminal business
  failure" — instead of smearing infrastructure/retry concerns through every
  handler signature (the POC's #1 pain).
- Preserves the typed error boundary end-to-end across the wire, a headline
  reason to build this on Effect Schema.
- Respects Restate's ownership of retries (transient = retry by default; terminal
  = explicit domain error). See the separate retry-ownership decision.
- Per-error `errorCode` lets callers distinguish 404/409/etc. instead of
  collapsing every domain failure to 500.

## Durable combinators have a clean `E` (no `RestateError`)

The durable combinators carry NO `RestateError` in their typed `E` — an infra
failure is a DEFECT classified at the boundary, never a typed failure a user must
`catchTag('RestateError', Effect.die)` away. Explicit signatures:

```ts
Restate.run<A, E, R>(name, effect: Effect<A, E, R>, options?)
                          : Effect<A, E, Exclude<R, DurableCaps> | RestateContext>  // inner E only
Restate.runExit<A, E, R>(name, effect, options?)
                          : Effect<Exit<A, E>, never, Exclude<R, DurableCaps> | RestateContext>  // observe
Restate.sleep(millis, name?)     : Effect<void,           never, RestateContext>
Restate.timeout<A>(descr, millis): Effect<A | undefined,  never, RestateContext>
Restate.all/race/any<T>(descrs)  : Effect<ResultsOf<T>[…], never, RestateContext>
State.for(S).get/set/clear/clearAll/stateKeys : Effect<…, never, StateRead|StateWrite | RestateContext>
Awakeable.make(S).promise        : Effect<T, never, never>
```

`Restate.run` journals the raw success `A` (the contract's serde-friendly value),
NOT a wrapped `Exit`/`Cause` (which the SDK's default journal serde cannot
round-trip). Only the inner effect's own domain `E` is carried in the type; in
practice the inner is `E = never` (domain errors are checked in the HANDLER body,
not inside a `run` closure — see the examples). A durable-op infra failure (incl. a
give-up after `ctx.run`'s own retries) is `Effect.die`'d as a `RestateError` at the
single `awaitDurable` seam, so the boundary classifies it (transient → retry;
terminal → fail). The `IngressFailed` client surface (`Restate.call`/`send`,
ingress) still carries a typed `RestateError` — it pairs with the typed
`decodeTerminalError` decode helper, a caller-facing boundary, not a journaled op.

Compensation/sagas OBSERVE a durable step via `Restate.runExit(name, effect)` →
`Effect<Exit<A, E>>`: the `Exit` captures success, a domain `E` failure, AND the
infra failure (a `Cause.Die` carrying the `RestateError`, via `Cause.dieOption`).

## Consequences

- Durable-combinator failures (`run`/`sleep`/`timeout`/`all`/`race`/`any`/
  `State.*`/`Awakeable` await) are defects by default with a CLEAN typed `E`;
  observing them for compensation is opt-in via `Restate.runExit`.
- Typed cross-wire transport requires both sides to share the error Schema (fine
  within a codebase; cross-language callers get the encoded JSON body + `_tag`).

Status: accepted

_Revised after design review: per-error `errorCode` (from the error annotation,
not hardcoded 500); the encoded error + `_tag` travel in the message BODY (not
`metadata`, which ingress cannot see); slot-aware serde (ingress input → 400,
internal-slot corruption → defect/retry)._

_Revised (#1): the durable combinators carry a CLEAN typed `E` (no `RestateError`)
— infra failures are `Effect.die`'d at the `awaitDurable` seam and classified at
the boundary, the no-op `catchTag('RestateError', die)` is gone, and `Restate.runExit`
is the opt-in observe form for compensation. The boundary also validates a thrown
failure against the declared `error` union (non-match → defect, no mis-encode)._
