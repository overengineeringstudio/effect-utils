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
  yield* Restate.reschedule({ contract: Self, method: 'cycle', input, delayMillis: 200 })
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

<!-- TODO(composition) -->
> **The full composed example is pending a refinement.** `Restate.reschedule` and
> `RestateScheduled` / `Restate.pollLoop` both exist and ship today (see
> [`examples/12-self-reschedule.ts`](../../examples/12-self-reschedule.ts) for the
> verified `NotionWatcher` primitive and the hand-rolled `RawWatcher` building
> block). A refinement to their *composition* — specifically how a `retryAfter`
> floor and an awakeable-wake compose into the loop cadence — is landing separately,
> and the full worked composition example will be filled in here once it lands. Until
> then, treat the example file as the verified reference for both levels.

## See also

- [Durable steps](./durable-steps.md) — the bounded `Restate.run` that holds per-cycle retry.
- [The endpoint and serving](./endpoint.md) — the daemon latency teaching in context.
- [decision 0012](../vrs/decisions/0012-self-reschedule.md) — the self-reschedule rationale.
