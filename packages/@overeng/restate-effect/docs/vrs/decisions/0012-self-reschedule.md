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
  `Restate.sleep`) is NOT yet enabled — a held-open in-handler sleep is exactly the
  anti-pattern this primitive replaces, but enabling the lint is tracked separately.

Status: accepted
