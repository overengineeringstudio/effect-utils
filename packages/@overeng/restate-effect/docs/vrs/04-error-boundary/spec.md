# Spec: 04-error-boundary

Specifies the error boundary (`toTerminal` / `classifyOutcome`), cancellation ↔
interruption, retry surfacing, and the saga/compensation mechanism. Builds on
[../requirements.md](../requirements.md) + [./requirements.md](./requirements.md);
terms in [../glossary.md](../glossary.md); rationale in
[../.decisions/](../.decisions/). See [../spec.md](../spec.md) for the index.

Traces: R11–R16, R21, R22, R31.

## 1. Error boundary

Traces: R11–R16. See
[../.decisions/0003](../.decisions/0003-error-boundary-model.md). POC reference:
`Endpoint.toTerminal`, `RestateError.ts`. (The serde slot classification it builds
on is [02-schema-serde](../02-schema-serde/spec.md); the boundary is invoked from
the per-invocation flow in
[01-authoring](../01-authoring/spec.md#per-invocation-runtime-boundary).)

```
Effect outcome                                  Restate outcome
──────────────────────────────────────────────────────────────────────────
success                              → encode  → return value
failure ∈ declared error Schema,     → encode  → TerminalError(code,
  terminal-annotated (default)                    body = {_tag, …fields})  no retry
  · code from terminal/retryable annotation (default 500); _tag also in metadata
failure ∈ declared error Schema,     → throw   → RetryableError           retries
  retryable-annotated  (retryAfter?)             (retryAfter projected per-instance)
failure ∉ declared error Schema      → defect  → normal error             retries
  (classification drift)                          (no silent mis-encode)
Restate.retryable(eff, {retryAfter}) → throw   → RetryableError           retries
defect (incl. durable-combinator     → throw   → normal error             retries
  infra failures, classified at boundary)
interrupt (Restate cancellation)     → (finalizers ran) → not terminal, not retried
suspension (isSuspendedError)        → rethrow  → (not a failure)          resumes
```

- The handler `E` channel carries only declared business errors (R11). The
  binding's own bridge failures (`Restate.run`/`sleep`/`timeout`/`all`/`race`/
  `any`/`State.*`/`Awakeable` await/durable-promise) NEVER appear in a combinator's
  typed `E` (#1, decision 0003): a durable-op infra failure is a single tagged
  `RestateError` (`reason` discriminator) classified at the boundary as a DEFECT
  (transient infra → Restate retries; a terminally-failed step → fail, no retry),
  so it leaves the domain channel without a user-written `catchTag('RestateError',
die)` (R13). The durable combinators thus have a CLEAN `E` (see
  [03-effect-runtime](../03-effect-runtime/spec.md#determinism-layer)), and only the
  INNER effect's own domain `E` flows through `Restate.run`. The `IngressFailed`
  client surface (`Restate.call`/`send`, ingress) still surfaces a typed
  `RestateError` (it pairs with the typed `decodeTerminalError` decode helper).
- The boundary VALIDATES a thrown domain failure against the contract's declared
  `error` union before encoding it (`Schema.encodeUnknownEither`). A failure that
  does NOT match the declared union is classification DRIFT — surfaced as a DEFECT
  (the squashed cause, so the SDK retries and the bug is visible) rather than
  mis-encoding garbage into the terminal body.
- `terminal`/`retryable` is read PER UNION MEMBER. The annotation lives on a single
  error member, but a declared `error` is commonly a `Schema.Union` (e.g. a
  retryable 429 alongside a terminal 404) and the annotation sits on the MEMBERS,
  not the union node. `classifyOutcome` therefore resolves the matching member for
  the actual failing error (the one whose `encodeUnknownEither` accepts it) and
  reads the class off THAT member; a non-union schema (or no match) passes through
  unchanged, and the encode still uses the declared schema. Without this, every
  retryable member of a union mis-classifies as the default terminal (the bug the
  composed `pollLoop` `errorSchema` re-arm depends on; see
  [06-scheduling](../06-scheduling/spec.md), decision 0012).
- The encoded error AND its `_tag` travel in the `TerminalError` `message` BODY —
  `TerminalError(message, options)` has no separate body channel, and an ingress
  caller only sees `status` + `responseText` (the message), so `metadata` is
  invisible to ingress. `metadata._tag` is a best-effort extra for server-side
  consumers only (server ≥1.6). The errorCode is per-error (404/409/… expressible)
  via the error's `terminal`/`retryable` annotation
  ([../.decisions/0011](../.decisions/0011-restate-schema-annotations.md)).
- Observing a durable-combinator failure for compensation is OPT-IN via
  `Restate.runExit(name, effect)` → `Effect<Exit<A, E>>`: the `Exit` captures a
  success, a domain `E` failure (`Cause.Fail`), AND an infra failure (a
  `Cause.Die` carrying the `RestateError`, via `Cause.dieOption`), so a handler can
  branch and run a compensating durable step without the failure escaping — instead
  of the failure dying as a defect. (The default `Restate.run` keeps a clean `E`.)
- The ingress client's decode helper reverses the transport: it
  `JSON.parse`s the `responseText` (the message body) and re-`Schema.decode`s it
  back into the original tagged error, so callers `catchTag` typed errors (R14, see
  [05-clients](../05-clients/spec.md#external-ingress-client)).

---

## 2. Cancellation ↔ interruption

Traces: R31. See the invocation lifecycle in
[01-authoring](../01-authoring/spec.md#invocation-lifecycle).

A Restate cancellation surfaces as an Effect INTERRUPTION at the next await point,
so `onInterrupt` / `acquireRelease` finalizers and saga compensations run before
the attempt unwinds (R31, section 4 below + the lifecycle). The boundary does NOT
terminalize an interruption and does NOT blindly retry it — an interruption is
neither a domain failure nor a defect. The attempt's
`Request.attemptCompletedSignal` (`AbortSignal`) is bridged to attempt-scoped
finalization (e.g. releasing a DB handle), with the caveat that the same logical
invocation may get a NEW attempt later, so attempt-scoped cleanup must be
idempotent. `CancelledError extends TerminalError`; `explicitCancellation` (R35,
see [01-authoring](../01-authoring/spec.md#surfaced-servicehandler-options)) opts a
service into manual cancellation propagation.

---

## 3. Retry surfacing

Traces: R21, R22. See [../.decisions/0006](../.decisions/0006-restate-owns-retries.md).

Durable retries are Restate's. The binding never wraps a durable operation in
`Effect.retry` / `Effect.repeat` (R21). Restate's controls are surfaced as typed
options:

- `retryPolicy` on service/handler builders: `maxAttempts`, `initialInterval`,
  `maxInterval`, `exponentiationFactor`, `onMaxAttempts: 'pause' | 'kill'`.
- `RunOptions` on `Restate.run`: per-step `maxRetryAttempts`, `maxRetryDuration`,
  intervals, factor; on giving up, `ctx.run` converts to a terminal failure.
- `Restate.retryable(errorSchema, { retryAfter? })` / a `RetryableError` as the
  explicit retryable signal (R22). `retryAfter` is either a STATIC `Duration`
  shorthand OR an INSTANCE PROJECTION `(error) => DurationInput | undefined` read
  off the ACTUAL failing error at the boundary (e.g. a 429's `e.retryAfterMillis`),
  mirroring `idempotencyKey` — the fact lives on the schema, read once at
  `toTerminal` (#3,
  [../.decisions/0011](../.decisions/0011-restate-schema-annotations.md)).
  A projection returning `undefined` falls back to Restate's default backoff for
  that instance.

`Effect.retry` / `Schedule` remain available for pure, non-durable computation
only (lint/doc enforced).

The `name` arg of `Restate.run` is load-bearing for trace identity and journal
labeling; duplicate names are legal but trace-confusing, so the binding should
encourage distinct names per durable step.

---

## 4. Saga / compensation (future)

Spec note, not v1 surface. See
[../.decisions/0001](../.decisions/0001-thin-faithful-restate-binding.md) (faithful
binding) and the [Deferred](../spec.md#deferred-designed-for-later) list.

Restate ships no saga type; the pattern is built from primitives. The intended
Effect-native mechanism:

```
acquireRelease / onError finalizers, each compensation backed by Restate.run
    step succeeds → register compensation (a Restate.run that undoes it)
    later terminal error OR Effect interruption ↔ Restate cancel
        → run registered compensations in reverse (each a durable Restate.run)
```

The cancel ↔ interrupt mapping itself is NOT deferred — it is specified in
section 2 (a Restate cancellation surfaces as an Effect interruption at the next
await point, finalizers/compensations run, the interruption is neither terminalized
nor retried). What this section defers is only the first-class `withCompensation`
helper that packages the register-and-unwind pattern; until then the saga is
expressible by hand with `Restate.run` + Effect finalizers, relying on the
section-2 guarantee. Compensations must themselves be durable steps (`Restate.run`)
so they survive replay.
