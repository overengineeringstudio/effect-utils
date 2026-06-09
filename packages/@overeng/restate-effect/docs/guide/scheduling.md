# Self-reschedule and durable scheduling

[← Handbook index](./README.md)

A durable daemon — a poller or watcher that wakes periodically, forever — is **not**
a held-open `for(;;){ poll(); sleep() }`. The idiomatic Restate shape is a chain of
**delayed self-sends**: each invocation does ONE bounded unit of work, re-arms
itself via a delayed self-send, and RETURNS. Each invocation therefore has a bounded
journal (it does not grow with the number of cycles), the per-key write lock is
released between cycles, and crash/restart durability is free — the pending delayed
timer survives a server restart and re-fires.

## The p99 latency rule

A durable daemon uses a one-way `send` + a delayed self-send, **never** a blocking
`call`. A blocking ingress `call` into a per-key Virtual Object serializes behind
that key's write lock and stacks on top of the platform's retry backoff; under load
this was measured at an 18.4s p99. The self-send shape (`Restate.reschedule` /
`RestateScheduled`) returns immediately after enqueuing the next cycle.

## The two levels

The binding exposes two levels, both in
[`examples/12-self-reschedule.ts`](../../examples/12-self-reschedule.ts):

- **`Restate.reschedule`** — the typed durable self-send building block. The author
  passes the lexical `self` contract (the SDK has no runtime self-reflection); the
  send targets `Restate.key`, so it stays on the same single-writer instance.

  ```ts
  // inside a keyed handler — re-arm one of this Object's own handlers after a delay:
  yield * Restate.reschedule({ contract: Self, method: 'cycle', input, delayMillis: 200 })
  ```

  Re-arm **before** the fallible work (advance the cursor + reschedule first, both
  journaled, THEN poll), so a re-arm journaled before a failure is still delivered
  and the loop survives a failing cycle.

- **`RestateScheduled.make` (a.k.a. `Restate.pollLoop`)** — the narrow primitive.
  You write ONE `cycle` effect; the primitive materializes a Virtual Object that owns
  the whole recurring lifecycle (schedule, stop condition, error policy, overlap
  prevention, and a `start`/`stop`/`status` control surface).
  - `schedule`: `Schedule.fixedDelay(ms)` only in v1 (`fixedRate`/`cron` deferred).
  - `onCycleError`: `skipToNext` (default — swallow a failing cycle, keep cadence) or
    `stopLoop` (stop the loop, status `failed`).
  - Stop: data-driven `{ stop: true }`, count-driven `stopWhen` / `maxIterations`, or
    external `stop` — all end as status `completed` / `stopped`.
  - `start` re-arms under a fresh **generation token**, so a stale in-flight timer
    no-ops when it lands — no overlapping chains.
  - There is intentionally **no `retryCycle` knob**: per-cycle durable retry belongs
    inside a BOUNDED `Restate.run`. An unbounded `Restate.run` retries forever and
    wedges the per-key write lock so `start`/`stop` block.

## Composition: Retry-After re-arm + webhook wake

A real watcher needs two more behaviors beyond a fixed cadence: honor a source's
`Retry-After` on a 429, and be woken EARLY by a webhook instead of always waiting
out the delay. Both compose into the same `RestateScheduled.make` call (decision 0012) — see the verified
[`makeComposedDaemon`](../../examples/12-self-reschedule.ts) in the example file.

```ts
// A declared error UNION: a retryable 429 (Retry-After projected off the instance)
// + a terminal failure. The loop classifies each member at the boundary.
class RateLimited extends Schema.TaggedError<RateLimited>()('RateLimited', {
  retryAfterMillis: Schema.Number,
}) {}
class SourceFailed extends Schema.TaggedError<SourceFailed>()('SourceFailed', {
  message: Schema.String,
}) {}
const ComposedError = Schema.Union(
  Restate.retryable(RateLimited, { retryAfter: (e) => e.retryAfterMillis }),
  Restate.terminal(SourceFailed),
)

const Watcher = RestateScheduled.make({
  name: 'composed-watcher',
  domainState: { cursor: Schema.Number, itemsSeen: Schema.Number, wakeCount: Schema.Number },
  schedule: Schedule.fixedDelay(30_000),
  errorSchema: ComposedError, // route failures through classifyOutcome
  wake: true, // open a wake awakeable each cycle
  maxRetryBackoffs: 5, // cap consecutive 429 backoffs before demoting to onCycleError
  cycle: ({ key, wokenBy, state }) =>
    Effect.gen(function* () {
      if (wokenBy !== undefined) {
        /* The PREVIOUS inter-cycle wait was cut short by a webhook (wokenBy.reason). */
      }
      const cursor = (yield* state.get('cursor')) ?? 0
      const result = yield* poll(key, cursor) // a bounded Restate.run
      if (result._rateLimited) {
        // Fail with the RETRYABLE error; the loop re-arms after retryAfterMillis,
        // cursor + iteration FROZEN (the same logical cycle retries).
        return yield* Effect.fail(new RateLimited({ retryAfterMillis: result.retryAfterMillis }))
      }
      yield* state.set('cursor', result.nextCursor)
      return result.done ? { stop: true } : { stop: false }
    }),
})
```

### `errorSchema` — Retry-After re-arm

When a cycle's failure matches a `retryable`-annotated member of `errorSchema`, the
loop re-arms the NEXT cycle after that error's projected `retryAfter` floor (read off
the instance, e.g. a 429's `retryAfterMillis`) instead of the `fixedDelay`. The
**cursor and iteration are frozen** — it is the SAME logical cycle retrying, not an
advance. A `terminal` member (or an unclassified failure) instead hits `onCycleError`
(skip / stop). `maxRetryBackoffs` caps consecutive backoffs: past the cap, a
permanently-429 source is demoted to the `onCycleError` policy rather than backing off
forever.

The classification routes through the boundary's `classifyOutcome`, which resolves the
matching **union member** for the failing error — so a `retryable` 429 alongside a
`terminal` 404 in one union is honored per-member, not collapsed to terminal.

### `wake` — webhook-driven early fire

With `wake: true` the inter-cycle wait moves INSIDE the invocation as
`Restate.race([sleepDescriptor(delay), wake.descriptor])`. The loop opens a fresh
awakeable each cycle, persists its id in State, and exposes it via a `wakeId` **shared**
handler (readable while the exclusive cycle holds the lock). An external webhook reads
the id and resolves it via ingress `resolveAwakeable`; the race ends early and the next
cycle fires with delay 0. The wake reason is threaded to the next cycle as
`wokenBy`. The id is **rotated per cycle**; a stale id resolves harmlessly (its
awakeable belongs to a completed invocation).

> **Tradeoff — wake holds the lock.** In wake mode the per-key write lock is HELD
> during the inter-cycle wait (the race is inside the invocation), so an exclusive
> `stop` / `start` queues behind it, bounded by the sleep leg. The default **no-wake**
> shape is wedge-free: each backoff is a delayed self-send that RELEASES the lock, so
> `stop` returns instantly even mid-backoff. **Pair wake with short `retryAfter`
> floors** so a held backoff cannot delay control for long; prefer no-wake when a 429
> floor can be long and prompt `stop` matters more than early fire.

## See also

- [Durable steps](./durable-steps.md) — the bounded `Restate.run` that holds per-cycle retry.
- [The endpoint and serving](./endpoint.md) — the daemon latency teaching in context.
- [decision 0012](../vrs/decisions/0012-self-reschedule.md) — the self-reschedule rationale.
