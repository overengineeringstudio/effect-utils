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
cycle of the user's `cycle` effect, then re-arms via a delayed self-send. The user
writes ONE `cycle` effect; the primitive owns the lifecycle. The load-bearing
design choices (the spec owns the full mechanics):

- **A Virtual Object, not a Service — for overlap prevention.** The intrinsic
  per-key write lock guarantees at most one exclusive `cycle` per key (extra sends
  queue FIFO), so a duplicate `start`, a stale re-arm, or a slow cycle can never
  produce two concurrent cycles for one instance. The primitive RELIES on this
  rather than building its own lock; the key is the instance id, so N watchers run
  in parallel.
- **`fixedDelay` only (v1)** — the gap is END-to-START, so a slow cycle never
  overlaps and never catches up (the right poller shape). `Schedule` is a tagged
  union, leaving room for `fixedRate`/`cron` without a break.
- **`onCycleError` default `skipToNext`** re-arms anyway (steady cadence through a
  transient bad cycle); `stopLoop` stops the loop. It catches the FULL cause
  (failures AND defects) because a bounded `Restate.run` give-up is a `RestateError`
  DEFECT (clean `E`, decision 0003) that `catchAll` alone would miss. An interrupt
  is re-raised so Restate's replay/cancel semantics stand.
- **Generation-token re-arm** is how `stop` / restart / in-cycle stop INVALIDATE an
  in-flight delayed send WITHOUT a timer handle (the SDK gives none): a landing
  `cycle` no-ops if its generation is stale or the status is no longer `running`.
- **Re-arm BEFORE the fallible work** (both journaled first): a re-arm journaled
  before a later failure is STILL delivered, so the loop survives a failing cycle
  even under a terminal failure or kill (spike A 3b/4b). A data/`stopWhen`/
  `maxIterations` stop flips status and the already-armed next cycle no-ops via the
  generation+status guard.
- **`status` is a SHARED read-only query** (never takes the write lock, always
  answerable even mid-cycle); `start`/`stop` are exclusive; the internal `cycle` is
  `ingressPrivate`.

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

`make({ errorSchema })` routes a cycle failure through the boundary's
`classifyOutcome` — the SAME classifier the endpoint uses — instead of a blanket
catch, so "is this retryable + how long to back off" has ONE source of truth. A
`retryable` member re-arms after its PROJECTED `retryAfter` floor (read off the
failing instance, e.g. a 429's `retryAfterMillis`) with the cursor + iteration
FROZEN — the same logical cycle retrying; the floor is read back off the
`classifyOutcome` result, so it is computed once and identical to a plain handler's.
A `terminal`/defect/give-up falls to `onCycleError`; an interrupt is re-raised.
`maxRetryBackoffs?` (default unbounded) caps consecutive backoffs so a
permanently-429 source eventually demotes to `onCycleError` rather than backing off
forever. The backoff is a DELAYED SELF-SEND (the no-wake shape), so the write lock is
RELEASED during it and a `stop` mid-backoff completes promptly.

This surfaced ONE general boundary fix: `classifyOutcome` must resolve the matching
union MEMBER for the actual failing error before reading the `terminal`/`retryable`
annotation — reading the top-level AST mis-classified a retryable member of a
`Schema.Union` as terminal. It affects any union-typed error channel; see
[04-error-boundary/spec.md](../04-error-boundary/spec.md) §1.

### `wake` → awakeable-driven early fire

`make({ wake: true })` lets a webhook cut the inter-cycle wait short by moving the
wait INSIDE the invocation as `Restate.race([sleepDescriptor(delay), wake])` (the
deterministic descriptor combinator, decision 0005); a `wakeId` SHARED handler
exposes the per-cycle awakeable id for an external `resolveAwakeable`.

TRADEOFF (the reason wake is opt-in, not default): the in-invocation race HOLDS the
per-key write lock during the wait, so an exclusive `stop`/`start` queues behind it
(bounded by the sleep leg). The default NO-WAKE shape stays the wedge-free
delayed-send path (lock released between cycles). Because the durability reasoning
differs — no-wake relies on the pre-armed delayed send, wake on the journaled held
race — `make` materializes TWO distinct `cycle` bodies behind one config rather than
branching inside one. Both survive a SIGKILL mid-wait
(`src/scheduling/scheduled-durability.integration.test.ts`).

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
