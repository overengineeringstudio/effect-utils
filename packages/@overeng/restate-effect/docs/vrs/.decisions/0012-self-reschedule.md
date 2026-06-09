# Self-reschedule: a durable self-send building block + a narrow poll-loop primitive

A durable daemon (a poller / watcher that wakes periodically forever) is NOT a
held-open `for(;;){ poll(); sleep() }`. The idiomatic Restate shape is a chain of
DELAYED SELF-SENDS: each invocation does one bounded unit of work, re-arms itself
via a delayed self-send, and RETURNS — so each invocation completes with a
BOUNDED journal (the journal does not grow with the number of cycles), the per-key
write lock is released between cycles, and crash/restart durability comes for free
(the pending delayed timer survives a server restart and re-fires).

We ship this at TWO levels (validated by two design spikes,
`tmp/restate-spike-reschedule-{a,b}`):

## (a) `Restate.reschedule` — the typed durable self-send building block

```ts
Restate.reschedule({ contract, method, input, delayMillis })
//   : Effect<void, RestateError, ObjectKey | RestateContext>
```

A thin, typed wrapper over the in-handler object send (`Restate.objectSendClient`
= `ctx.objectSendClient(...).handler(..., { delay })`): it reads the current key
(`Restate.key`) and issues a delayed send to one of the CURRENT Object's own
handlers. The SDK has no runtime self-reflection ("what contract am I?"), so the
author passes the SAME `contract` the handler is implemented against (the lexical
`self`). Capability-gated to keyed handlers (requires `ObjectKey`, so it cannot be
issued from a Service). The send is journaled, so a replay does not double-send —
the re-arm is idempotent under replay.

This is the unopinionated block: the stop condition, the failure policy, and the
domain cursor are all hand-written by the author. It is the right tool when the
loop shape does not fit the narrow primitive.

## (b) `RestateScheduled.make` / `Restate.pollLoop` — the narrow primitive

```ts
RestateScheduled.make({ name, domainState, cycle, schedule, onCycleError?, stopWhen?, maxIterations? })
//   : { contract, implementation }
```

Materializes a Virtual Object whose internal `cycle` handler runs one bounded
cycle of the user's `cycle` effect, then re-arms via a delayed self-send. The
user writes ONE `cycle` effect; the primitive owns the lifecycle:

- **Why a Virtual Object, not a Service.** Overlap prevention is the load-bearing
  reason. A Virtual Object has an intrinsic per-key write lock: at most one
  exclusive `cycle` runs at a time per key, additional sends queue FIFO. A
  duplicate `start`, a stale re-arm, or a slow cycle that outlives its delay can
  never produce two concurrent cycles for the same instance — the primitive RELIES
  on this single-writer guarantee rather than building its own lock. The key is the
  scheduled-instance id, so N independent watchers run fully in parallel.

- **`fixedDelay` only (v1).** The gap between the END of one cycle and the START of
  the next is exactly `delayMillis`. A slow cycle pushes everything later; the loop
  never overlaps and never tries to catch up — the right shape for a poller.
  `Schedule` is a tagged union so `fixedRate`/`cron` can be added without a
  breaking change.

- **`onCycleError` default `skipToNext`.** A failing cycle is swallowed (recorded
  as `lastError`) and the loop re-arms anyway, keeping cadence steady through a
  transient bad cycle. `stopLoop` instead stops the whole loop (status `failed`).
  The policy catches the FULL cause (failures AND defects), because a cycle's
  bounded `Restate.run` give-up is a `RestateError` DEFECT (clean `E`, decision
  0003), not a typed failure — `catchAll` alone would miss it. An interrupt
  (suspension / cancellation) is re-raised so Restate's replay/cancel semantics
  stand.

- **Generation-token re-arm.** Every `start` bumps a `generation` token; the
  delayed re-arm carries the generation it was armed under, and a landing `cycle`
  no-ops if its generation is stale OR the status is no longer `running`. This is
  how `stop`, a restart, or an in-cycle stop cleanly INVALIDATE any in-flight
  delayed send WITHOUT a timer handle (the SDK gives us none).

- **Safe re-arm-BEFORE-fallible-work ordering.** The cycle advances its counter AND
  re-arms the next cycle FIRST (both journaled), THEN runs the user's fallible
  work. A re-arm journaled before a later failure is STILL delivered, so the loop
  survives a failing cycle even under a terminal failure or a kill — the next cycle
  is already enqueued (spike A scenarios 3b/4b). When the cycle ends the loop
  (data-driven `{ stop: true }`, `stopWhen`, or `maxIterations`), it flips status
  to `completed`/`failed`; the already-armed next cycle then lands and no-ops via
  the generation+status guard.

- **`start` / `stop` / `status` control.** `start`/`stop` are exclusive
  (write-lock) handlers; `status` is a SHARED read-only query that never takes the
  write lock, so it is always answerable — even while an exclusive cycle holds the
  lock. The internal `cycle` is `ingressPrivate` (only the Object's own re-arm send
  may invoke it).

## No primitive-level `retryCycle` knob

Per-cycle durable retry belongs INSIDE the cycle's BOUNDED `Restate.run`, not as a
primitive knob. Two findings force this (spike B `error-policy` / `probe-run-retry`):

1. **Restate journals a give-up.** Once `ctx.run` exhausts its bounded retry, the
   give-up is JOURNALED. A primitive cannot honestly "re-run" the cycle by
   replaying the outer invocation — the journal would replay the give-up, not
   re-execute the work. The only layer that actually RE-EXECUTES the work is the
   inner `Restate.run`'s own durable retry.

2. **An unbounded retry WEDGES the per-key write lock.** A `Restate.run` with NO
   retry bound (the SDK default) retries FOREVER and never surfaces. The cycle
   invocation never completes, so it holds the per-key exclusive write lock
   indefinitely — and a `stop`/`start` queued behind it BLOCKS. The control surface
   becomes unresponsive. So: ALWAYS bound the per-cycle `Restate.run`; the
   primitive cannot paper over an unbounded one.

The shipped guidance: wrap the fallible work in a BOUNDED `Restate.run(name,
action, { maxRetryAttempts })`. That is where per-cycle retry lives; the policy
then decides skip vs stop on the bounded give-up.

## Composition: Retry-After re-arm + webhook wake

The narrow primitive composes two more behaviors a real watcher needs, both opt-in
on `make` (validated by `src/scheduling/scheduled-compose.integration.test.ts`,
productizing `tmp/restate-spike-pollloop-compose`). Crucially, neither is a NEW
retry mechanism — they thread the EXISTING boundary classification + descriptor
primitives into the loop cadence, so there is still ONE source of truth for "is
this error retryable + how long to back off".

### `errorSchema` → Retry-After re-arm (the SINGLE source of truth)

`make({ errorSchema })` declares the cycle's error union (a `Schema.TaggedError` /
`Schema.Union`, annotated `Restate.retryable(...)` / `Restate.terminal(...)`). A
cycle failure is routed through the boundary's `classifyOutcome` — the SAME
classifier the endpoint uses — instead of a blanket catch:

- A `retryable` member RE-ARMS the next cycle after its PROJECTED `retryAfter`
  floor (read off the failing instance, e.g. a 429's `retryAfterMillis`), with the
  cursor AND iteration FROZEN — it is the SAME logical cycle retrying, not an
  advance. The floor is read back off the `RetryableError` `classifyOutcome`
  produced, so the projection is computed ONCE and is identical to what the
  boundary would have used had the error escaped a plain handler.
- A `terminal` member / defect / give-up falls to the existing `onCycleError`
  policy (skip / stop).
- An interrupt is re-raised (cancel/suspension semantics stand).
- `maxRetryBackoffs?` (default unbounded) caps consecutive backoffs for one logical
  cycle; past the cap the retryable failure is DEMOTED to `onCycleError`, so a
  permanently-429 source eventually skips/stops instead of backing off forever.

The re-arm is implemented WITHOUT un-sending the pre-armed `delayMillis` send: the
committed "re-arm-before-fallible-work" ordering pre-arms a `delayMillis` send, so
on a retryable outcome the cycle BUMPS the generation and arms a FRESH `retryAfter`
send under the new generation — the already-armed `delayMillis` send then lands and
no-ops via the generation guard. The backoff is therefore a DELAYED SELF-SEND in
the no-wake shape, so the per-key write lock is RELEASED during the backoff and a
`stop` mid-backoff completes promptly (measured ~3ms into a 3000ms backoff).

This required ONE boundary fix: `classifyOutcome` previously read the
`terminal`/`retryable` annotation off the declared schema's top-level AST, which
for a `Schema.Union` is the un-annotated union node — so a retryable union member
(a 429 alongside a terminal error, the realistic case) silently mis-classified as
terminal. The classifier now resolves the matching union MEMBER for the actual
failing error (the one whose `encodeUnknownEither` accepts it) before reading the
class. This is a general boundary correctness fix (it affects any union-typed error
channel, not just pollLoop); see [04-error-boundary/spec.md](../04-error-boundary/spec.md) §1.

### `wake` → awakeable-driven early fire

`make({ wake: true })` lets a webhook cut the inter-cycle wait short. The
inter-cycle wait then moves INSIDE the invocation as
`Restate.race([sleepDescriptor(delay), wake.descriptor])` (the deterministic
descriptor combinator, decision 0005). Each cycle opens a FRESH awakeable, persists
its id in State, and exposes it via a `wakeId` SHARED handler (readable while the
exclusive cycle holds the lock). An external webhook reads the id and resolves it
via ingress `resolveAwakeable`; the race ends early and the next cycle re-arms with
delay 0. The wake reason is threaded to the next cycle as `wokenBy` (a one-shot
payload). The id is ROTATED per cycle; a stale id resolves harmlessly (its
awakeable belongs to a completed invocation).

TRADEOFF (documented): wake mode HOLDS the per-key write lock during the
inter-cycle wait (the race is in-invocation), so an exclusive `stop`/`start` queues
behind it, bounded by the sleep leg (~3s in the probe). The default NO-WAKE shape
stays the WEDGE-FREE delayed-send path (lock released between cycles). Recommend
pairing wake with SHORT `retryAfter` floors, or preferring no-wake when a long 429
floor and prompt `stop` matter more than early fire.

### Two materialized loop bodies

The no-wake delayed-send shape and the wake held-race shape differ enough that
`make` materializes TWO distinct `cycle` bodies behind one config (selected on
`wake`), rather than branching deep inside one body — the cleanest structure given
the durability reasoning differs (no-wake relies on the pre-armed delayed send; wake
relies on the journaled held race + the persisted generation). Durability holds for
both: a SIGKILL mid inter-cycle wait resumes after restart (the held race's timer /
the pending delayed send survives), verified by
`src/scheduling/scheduled-durability.integration.test.ts`.

## p99 latency teaching

A blocking ingress `call` into a per-key Virtual Object serializes behind that
key's write lock and STACKS on top of the platform's retry backoff. Under load the
stress runs measured an 18.4s p99 for the blocking-`call` shape (blocking call ×
per-key queue × retry backoff). A durable daemon therefore uses a one-way SEND +
delayed self-send (the `reschedule`/`pollLoop` shape), NEVER a blocking `call`:
the caller enqueues the next cycle and returns immediately. This is documented
prominently in the README and the `examples/12-self-reschedule.ts` example.

## Deferred (documented non-goals / follow-ups)

- `fixedRate` (drift-corrected cadence) and `cron` scheduling. The spike prototyped
  both, but a production cron needs a vetted evaluator and `fixedRate` needs the
  journaled-clock anchor; both are kept out of v1. The `Schedule` tagged union
  leaves room.
- Runtime `reconfigure` (change the schedule of a live loop). Expressible via the
  same generation-bump-and-re-arm mechanism the prototype showed; deferred.
- A `stalled` status for an exhausted-retry stall. The dying handler cannot
  reliably self-mark; stall is observable as iteration stagnation. Deferred until a
  finalizer-based marking is proven.

## Why

- The bounded-journal, single-writer, crash-durable daemon shape is the one
  Restate is BUILT for; surfacing it as a typed primitive removes the boilerplate
  and the footguns (re-arm ordering, stale-timer invalidation, lock-wedging
  retries) that a hand-rolled loop repeatedly hits.
- Shipping the building block AND the narrow primitive keeps the escape hatch open
  (a loop that does not fit the primitive uses `reschedule` directly) without
  over-generalizing the primitive.

## Consequences

- The primitive's domain cursor lives in the SAME Object state map as its control
  plane, under a separate `State.for` block; `harness.stateOf` against the
  primitive's contract sees only the control plane (a same-named probe contract
  reads the domain keys). A future ergonomic could merge the two typed views.
- `reschedule` and `pollLoop` are on the core `.` surface (no new subpath).
- The lint `overeng/no-non-durable-wait` (steer a handler `Effect.sleep` to
  `Restate.sleep`) is now enabled (`error` on `restate-effect/src/**`, exempting
  the test + harness files) — a held-open in-handler sleep is exactly the
  anti-pattern this primitive replaces, and the lint backstops it.

Status: accepted
