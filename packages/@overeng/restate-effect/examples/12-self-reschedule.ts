/**
 * Self-reschedule: a durable daemon as a chain of delayed self-sends (#4).
 *
 * The idiomatic Restate watcher is NOT a held-open `for(;;){ poll(); sleep() }`.
 * It is a Virtual Object whose `cycle` handler does ONE bounded unit of work,
 * re-arms itself via a DELAYED SELF-SEND, and RETURNS — so each invocation
 * completes with a bounded journal and the per-key write lock is released between
 * cycles. Crash/restart durability comes for free: the pending delayed timer
 * survives a server restart and re-fires.
 *
 * THE p99 LATENCY TEACHING — a durable daemon uses a one-way SEND + a delayed
 * self-send, NEVER a blocking `call`. A blocking ingress `call` into a per-key
 * Virtual Object serializes behind that key's write lock and stacks on top of the
 * platform's retry backoff; under load the stress runs measured an 18.4s p99 for
 * the blocking-`call` shape. `Restate.reschedule` / `RestateScheduled` are
 * one-way: the caller enqueues the next cycle and returns immediately.
 *
 * This file shows BOTH levels:
 *  1. {@link NotionWatcher} — the narrow `RestateScheduled.make` primitive: you
 *     write ONE `cycle` effect and the primitive owns the lifecycle (schedule,
 *     stop condition, error policy, overlap prevention, start/stop/status).
 *  2. {@link RawWatcherObj} — the same loop hand-rolled from the `Restate.reschedule`
 *     building block, to show what the primitive does for you (and the SAFE
 *     re-arm-BEFORE-fallible-work ordering it bakes in).
 *
 * Verified end-to-end by `src/scheduled.integration.test.ts`.
 */
import { Effect, Schema } from 'effect'

import { Restate, RestateObject, RestateScheduled, State } from '../src/mod.ts'

/* ════════════════════════════════════════════════════════════════════════
 * 1. The narrow primitive: a durable Notion-style page watcher.
 * ════════════════════════════════════════════════════════════════════════ */

/* The watcher's OWN domain State (separate from the primitive's control plane):
 * a poll cursor + a running tally of items seen. A real watcher would store a
 * Notion `last_edited_time` / pagination cursor here. */
export const WatcherState = {
  cursor: Schema.Number,
  itemsSeen: Schema.Number,
} as const

const Watcher = State.for(WatcherState)

/**
 * Poll one page of a (stubbed) source. In a real watcher this is the Notion API
 * call, wrapped in a BOUNDED `Restate.run` so it is journaled AND so a transient
 * failure is retried IN PLACE (the per-cycle retry — there is no `retryCycle` knob
 * on the primitive; this bounded `Restate.run` is where per-cycle durable retry
 * lives). The `cursor` advances by one page per poll; `done` drives a clean
 * data-driven stop. The stub is module-level so a test can swap behaviors.
 */
export interface SourcePage {
  readonly nextCursor: number
  readonly itemCount: number
  readonly done: boolean
}
export type SourceBehavior = (cursor: number) => SourcePage
let sourceBehavior: SourceBehavior = (cursor) => ({
  nextCursor: cursor + 1,
  itemCount: 1,
  done: cursor >= 4,
})
/** Test seam: install a per-run source behavior (a real watcher calls the API). */
export const setSourceBehavior = (behavior: SourceBehavior): void => {
  sourceBehavior = behavior
}

/**
 * The durable Notion watcher. One `cycle`: read the cursor, poll one page (a
 * bounded `Restate.run`), advance the cursor + tally, and end the loop when the
 * source reports `done`. The primitive re-arms the next cycle after `fixedDelay`
 * and owns start/stop/status. `skipToNext` (the default) keeps the cadence steady
 * through a transient bad cycle; a bounded `Restate.run` absorbs flaky polls.
 */
export const NotionWatcher = RestateScheduled.make<typeof WatcherState>({
  name: 'notion-watcher',
  domainState: WatcherState,
  schedule: RestateScheduled.Schedule.fixedDelay(200),
  onCycleError: RestateScheduled.OnCycleError.skipToNext(),
  cycle: ({ key }) =>
    Effect.gen(function* () {
      const cursor = (yield* Watcher.get('cursor')) ?? 0
      const itemsSeen = (yield* Watcher.get('itemsSeen')) ?? 0
      /* The poll is a BOUNDED durable step: journaled + per-cycle retry in place. */
      const page = yield* Restate.run(
        `poll(${key}@${cursor})`,
        Effect.sync(() => sourceBehavior(cursor)),
        { maxRetryAttempts: 3, initialRetryIntervalMillis: 50 },
      )
      yield* Watcher.set('cursor', page.nextCursor)
      yield* Watcher.set('itemsSeen', itemsSeen + page.itemCount)
      /* Data-driven stop: the source has no more pages → end the loop cleanly. */
      return page.done ? { stop: true } : { stop: false }
    }),
})

/* ════════════════════════════════════════════════════════════════════════
 * 2. The building block: the SAME loop hand-rolled from `Restate.reschedule`.
 * ════════════════════════════════════════════════════════════════════════ */

export const RawWatcherState = {
  /** Gates re-arm. `stop` clears it; the next cycle sees it and does not re-arm. */
  running: Schema.Boolean,
  /** Advanced once per successful cycle. */
  cursor: Schema.Number,
} as const

const Raw = State.for(RawWatcherState)

export const RawWatcherObj = RestateObject.contract('raw-watcher', {
  state: RawWatcherState,
  handlers: {
    /** Arm the loop: set running, fire cycle 0 immediately. */
    start: { input: Schema.Void, success: Schema.Void },
    /** Halt the chain: clear the running flag. */
    stop: { input: Schema.Void, success: Schema.Void },
    /** Read-only inspection (no write lock). */
    read: {
      input: Schema.Void,
      success: Schema.Struct({ running: Schema.Boolean, cursor: Schema.Number }),
      shared: true,
    },
    /** INTERNAL: one cycle — re-arm via a delayed self-send, then return. */
    cycle: { input: Schema.Void, success: Schema.Void, options: { ingressPrivate: true } },
  },
})

export const RawWatcherLive = RestateObject.implement<typeof RawWatcherObj>(RawWatcherObj, {
  start: () =>
    Effect.gen(function* () {
      yield* Raw.set('running', true)
      if (((yield* Raw.get('cursor')) ?? undefined) === undefined) yield* Raw.set('cursor', 0)
      /* Arm cycle 0 immediately (delay 0). A `reschedule` infra failure is a
       * defect (clean `E`, decision 0003), so `orDie` it — the handler declares no
       * domain error. */
      yield* Restate.reschedule({
        contract: RawWatcherObj,
        method: 'cycle',
        input: undefined,
        delayMillis: 0,
      }).pipe(Effect.orDie)
    }),
  stop: () => Raw.set('running', false),
  read: () =>
    Effect.gen(function* () {
      const running = (yield* Raw.get('running')) ?? false
      const cursor = (yield* Raw.get('cursor')) ?? 0
      return { running, cursor }
    }),
  cycle: () =>
    Effect.gen(function* () {
      /* STOP CONDITION (author-written): not running → no re-arm → chain ends. */
      const running = (yield* Raw.get('running')) ?? false
      if (running === false) return

      /* SAFE ORDERING: advance + re-arm FIRST (both journaled), THEN do fallible
       * work — so a re-arm journaled before a failure is still delivered and the
       * loop survives a failing cycle. (The primitive bakes this in for you.) */
      const cursor = (yield* Raw.get('cursor')) ?? 0
      yield* Raw.set('cursor', cursor + 1)
      yield* Restate.reschedule({
        contract: RawWatcherObj,
        method: 'cycle',
        input: undefined,
        delayMillis: 200,
      }).pipe(Effect.orDie)
      /* ... the actual poll/work would go here (a bounded `Restate.run`) ... */
    }),
})
