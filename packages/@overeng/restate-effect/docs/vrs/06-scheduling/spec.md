# Spec: 06-scheduling

Specifies self-reschedule and durable scheduling (`reschedule` / `pollLoop`),
including the Retry-After re-arm and webhook-wake composition. Builds on
[../requirements.md](../requirements.md) + [./requirements.md](./requirements.md);
terms in [../glossary.md](../glossary.md); rationale in
[../.decisions/0012](../.decisions/0012-self-reschedule.md). See
[../spec.md](../spec.md) for the index.

Traces: R10/R32 (clients) + R19 (deterministic concurrency) + R33 (awakeables),
composed.

## Self-reschedule and durable scheduling

A durable daemon (a poller/watcher that wakes periodically forever) is a chain of
DELAYED SELF-SENDS, not a held-open `for(;;){ poll(); sleep() }`. Each invocation
does one bounded unit of work, re-arms itself via a delayed self-send, and
RETURNS — so each invocation has a BOUNDED journal (it does not grow with cycle
count), the per-key write lock is released between cycles, and crash/restart
durability is free (the pending delayed timer survives a restart and re-fires).
See [../.decisions/0012](../.decisions/0012-self-reschedule.md). Two levels:

**Building block — `Restate.reschedule`.** A typed delayed self-send: read the
current key (`Restate.key`) and send to one of the CURRENT Object's own handlers.
Capability-gated to keyed handlers (`ObjectKey`). The author passes the lexical
`self` contract (the SDK has no runtime self-reflection). The send is journaled →
idempotent under replay. (Built on the delayed-send primitive, see
[05-clients](../05-clients/spec.md#in-handler-service-to-service-clients).)

```ts
yield * Restate.reschedule({ contract: Self, method: 'cycle', input, delayMillis: 200 })
//   : Effect<void, RestateError, ObjectKey | RestateContext>
```

**Narrow primitive — `RestateScheduled.make` / `Restate.pollLoop`.** Materializes
a Virtual Object that owns the recurring lifecycle; the user writes ONE `cycle`
effect.

```ts
const Watcher = RestateScheduled.make({ name, domainState, cycle, schedule, onCycleError?, stopWhen?, maxIterations?, errorSchema?, wake?, maxRetryBackoffs? })
// → { contract, implementation }; drive start/stop/status/wakeId via the typed clients
```

- `schedule`: `Schedule.fixedDelay(ms)` only in v1 (the gap between cycles is
  exactly `ms`; never overlaps, never catches up). `fixedRate`/`cron` deferred.
- `onCycleError`: `skipToNext` (DEFAULT — swallow a failing cycle, keep cadence) or
  `stopLoop` (stop the loop, status `failed`). The policy catches the full cause
  (failure AND defect), since a cycle's bounded `Restate.run` give-up is a
  `RestateError` defect (see
  [04-error-boundary](../04-error-boundary/spec.md#error-boundary)); an interrupt is
  re-raised.
- Stop: data-driven `{ stop: true }` from inside the cycle, count-driven `stopWhen`
  / `maxIterations`, or external `stop`. All end as status `completed`/`stopped`.
- `start`/`stop` are exclusive; `status` is a SHARED read-only query (no write
  lock). The internal `cycle` is `ingressPrivate`.
- A GENERATION token, bumped on every `start`, invalidates stale delayed sends
  (a landing `cycle` no-ops if its generation is stale or the status is not
  `running`) — the overlap-prevention + idempotency seam, no timer handle needed.
- SAFE ORDERING: advance the counter AND re-arm the next cycle FIRST (both
  journaled), THEN run the fallible work — so a re-arm journaled before a failure
  is still delivered and the loop SURVIVES a failing cycle.

There is intentionally NO primitive-level `retryCycle` knob. Per-cycle durable
retry belongs INSIDE the cycle's BOUNDED `Restate.run` (`{ maxRetryAttempts }`):
Restate journals a give-up that a primitive cannot honestly re-run, and an
UNBOUNDED `Restate.run` retries forever and WEDGES the per-key write lock so
`start`/`stop` block (decision 0012).

**Composition (decision 0012).** Two opt-in behaviors thread the existing boundary
classification + descriptor primitives into the loop cadence — neither is a new
retry mechanism:

- `errorSchema` → **Retry-After re-arm.** A declared error union routes a cycle
  failure through the boundary's `classifyOutcome` (the SINGLE source of truth, see
  [04-error-boundary](../04-error-boundary/spec.md#error-boundary)). A `retryable`
  member RE-ARMS the next cycle after its projected `retryAfter` floor (read off the
  failing instance), cursor + iteration FROZEN (the SAME logical cycle retries); a
  `terminal` member / defect falls to `onCycleError`. `maxRetryBackoffs?` (default
  unbounded) caps consecutive backoffs before demoting to `onCycleError`. In the
  no-wake shape the backoff is a delayed self-send (generation-bumped), so the lock
  is RELEASED and `stop` mid-backoff stays prompt. Depends on the per-union-member
  classification fix in
  [04-error-boundary](../04-error-boundary/spec.md#error-boundary).
- `wake` → **awakeable early fire.** With `wake: true` the inter-cycle wait moves
  INSIDE the invocation as `Restate.race([sleepDescriptor(delay), wake.descriptor])`
  (see
  [03-effect-runtime](../03-effect-runtime/spec.md#deterministic-concurrency)). Each
  cycle opens a fresh awakeable, persists its id (`wakeId`, a SHARED read-only
  handler so a webhook can read it under the held lock), and threads the wake reason
  to the next cycle as `wokenBy`. An ingress `resolveAwakeable` cuts the wait short.
  The id ROTATES per cycle; a stale id resolves harmlessly. TRADEOFF: wake mode
  HOLDS the write lock during the wait, so exclusive `stop`/`start` queue behind it
  (bounded by the sleep leg) — pair with short `retryAfter` floors; the default
  no-wake shape is wedge-free. The two shapes are materialized as two distinct
  `cycle` bodies. Durability holds for both (SIGKILL mid-wait resumes after
  restart).

**p99 latency rule.** A durable daemon uses a one-way SEND + delayed self-send,
NEVER a blocking ingress `call`. A blocking call into a per-key Virtual Object
serializes behind that key's write lock and stacks on the retry backoff — the
stress runs measured an 18.4s p99 for the blocking-call shape. The
`reschedule`/`pollLoop` shape returns immediately after enqueuing the next cycle.
