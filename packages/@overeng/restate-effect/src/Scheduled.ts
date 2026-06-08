/**
 * `RestateScheduled.make` (a.k.a. `Restate.pollLoop`) — a narrow durable
 * recurring-loop primitive (decision 0012, #4). It materializes a Virtual Object
 * whose INTERNAL `cycle` handler does ONE bounded cycle of the user's work, then
 * RE-ARMS itself via a delayed self-`send` (a chain of fresh bounded invocations,
 * NOT an in-process `for(;;)` loop). The user writes ONE `cycle` effect; the
 * primitive owns the recurring lifecycle: the schedule, the stop condition, the
 * per-cycle error policy, overlap prevention, and a `start`/`stop`/`status`
 * control surface.
 *
 * ── Why a Virtual Object (not a Service) ──────────────────────────────────
 * Overlap prevention is the load-bearing reason. A Virtual Object has an
 * intrinsic per-key write lock: at most ONE exclusive `cycle` runs at a time per
 * key, and additional sends queue FIFO. So a duplicate `start`, a stale re-arm,
 * or a slow cycle that outlives its delay can never produce two concurrent cycles
 * for the same scheduled instance — the primitive RELIES on this single-writer
 * guarantee rather than building its own lock. The key is the scheduled-instance
 * id (e.g. a source id), so N independent watchers run fully in parallel.
 *
 * ── Scope (v1) and deferred knobs ─────────────────────────────────────────
 * Shipped: `fixedDelay` scheduling, `onCycleError` (default `skipToNext`), stop
 * via `stopWhen` / `maxIterations` / in-cycle `{ stop: true }`, generation-token
 * re-arm, and the SAFE re-arm-BEFORE-fallible-work ordering. DEFERRED as
 * documented non-goals (see decision 0012): `fixedRate`, `cron`, and runtime
 * `reconfigure`. There is intentionally NO primitive-level `retryCycle` knob —
 * per-cycle durable retry belongs INSIDE the cycle's BOUNDED `Restate.run`
 * (Restate journals a give-up that a primitive cannot honestly re-run; an
 * unbounded retry wedges the per-key write lock so `start`/`stop` block).
 */
import { Cause, Effect, Schema } from 'effect'

import type { AnyImplementation } from './Endpoint.ts'
import { emitPollLoopCycle } from './Metrics.ts'
import { reschedule } from './Reschedule.ts'
import type { ObjectKey, StateRead, StateWrite } from './RestateContext.ts'
import { objectKey, RestateContext, stateFor } from './RestateContext.ts'
import type { RestateError } from './RestateError.ts'
import { RestateObject } from './Service.ts'

/* ════════════════════════════════════════════════════════════════════════
 * SEMANTICS the primitive commits to.
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * Per-cycle error policy (tagged union; DEFAULT = `skipToNext`).
 *
 * - `skipToNext` (DEFAULT) — a cycle that fails is SWALLOWED (recorded in state as
 *   `lastError`) and the loop RE-ARMS the next cycle anyway. This keeps a poller's
 *   cadence steady through a transient bad cycle. Combine with a bounded per-cycle
 *   `Restate.run` retry INSIDE the cycle to absorb flaky work before the policy
 *   ever sees a failure.
 *
 * - `stopLoop` — a failed cycle STOPS the whole loop (status → `failed`,
 *   `lastError` set). Use when any failure is fatal and should require an explicit
 *   restart.
 *
 * NOTE: there is no `retryCycle` option. To durably retry the work itself, bound
 * a `Restate.run(name, action, { maxRetryAttempts })` INSIDE the cycle (the only
 * place that honestly re-executes). An UNBOUNDED `Restate.run` retries forever and
 * wedges the per-key write lock so `stop` cannot run — always bound it (see
 * decision 0012 and the `error-policy.integration.test.ts` wedge scenario).
 */
export type OnCycleError = { readonly _tag: 'skipToNext' } | { readonly _tag: 'stopLoop' }

export const OnCycleError = {
  skipToNext: (): OnCycleError => ({ _tag: 'skipToNext' }),
  stopLoop: (): OnCycleError => ({ _tag: 'stopLoop' }),
} as const

/**
 * Schedule shape (tagged union; v1 ships `fixedDelay` ONLY).
 *
 * - `fixedDelay` — the GAP between the END of one cycle and the START of the next
 *   is exactly `delayMillis`. A slow cycle pushes everything later; the loop never
 *   overlaps and never tries to "catch up". This is the right shape for a poller
 *   (N ms of breathing room between polls regardless of how long a poll took).
 *
 * `fixedRate` and `cron` are DEFERRED (decision 0012) — kept as a tagged union so
 * the surface can grow without a breaking change.
 */
export type Schedule = { readonly _tag: 'fixedDelay'; readonly delayMillis: number }

export const Schedule = {
  fixedDelay: (delayMillis: number): Schedule => ({ _tag: 'fixedDelay', delayMillis }),
} as const

/**
 * Loop lifecycle status (tagged; persisted in State, readable via the `status`
 * SHARED handler — a read-only query that never takes the write lock, so it is
 * always answerable even while an exclusive cycle holds the lock).
 *
 * - `idle` — never started (or `start` not yet called).
 * - `running` — armed; a cycle is queued/running and the chain is live.
 * - `stopped` — `stop` was called; the chain is broken (a pending re-arm send,
 *   once it lands, observes `running=false` and no-ops).
 * - `failed` — the `stopLoop` policy fired on a cycle failure.
 * - `completed` — the stop CONDITION (`stopWhen` / `maxIterations` / in-cycle
 *   `{ stop: true }`) ended the loop cleanly.
 */
export type LoopStatusTag = 'idle' | 'running' | 'stopped' | 'failed' | 'completed'

/* ════════════════════════════════════════════════════════════════════════
 * The primitive's persisted control-plane State (internal to the Object). The
 * user's OWN domain state (e.g. a poll cursor) is a SEPARATE typed block the
 * `cycle` body reads/writes via the typed `state` it is handed.
 * ════════════════════════════════════════════════════════════════════════ */

const StatusSchema = Schema.Literal('idle', 'running', 'stopped', 'failed', 'completed')

/** The loop control-plane state, persisted in the Object's typed K/V State. */
const ControlState = {
  /** Lifecycle tag (the source of truth for "is the chain live"). */
  status: StatusSchema,
  /** Monotonic cycle counter (cycles ATTEMPTED; drives `maxIterations`). */
  iteration: Schema.Number,
  /**
   * Re-arm GENERATION token. Every `start` bumps this; the delayed re-arm send
   * carries the generation it was armed under, and a landing `cycle` no-ops if its
   * generation is stale. A `stop`-then-`start` thus cleanly INVALIDATES any
   * in-flight delayed send WITHOUT relying on cancelling the timer (the SDK gives
   * us no timer handle).
   */
  generation: Schema.Number,
  /** Last cycle error string (for `skipToNext`/`failed` diagnostics). */
  lastError: Schema.String,
} as const

/** The cycle input the internal `cycle` handler is sent (carries the generation). */
const CycleInput = Schema.Struct({ generation: Schema.Number })
type CycleInput = Schema.Schema.Type<typeof CycleInput>

/** The status the `status` shared handler returns. */
const StatusOutput = Schema.Struct({
  status: StatusSchema,
  iteration: Schema.Number,
  lastError: Schema.optional(Schema.String),
})
export type StatusOutput = Schema.Schema.Type<typeof StatusOutput>

/* ════════════════════════════════════════════════════════════════════════
 * `make` — the combinator.
 * ════════════════════════════════════════════════════════════════════════ */

/** The capability markers the materialized control plane uses internally (a cycle
 * that reads/writes its domain cursor via the typed `state` needs these). `make`
 * ABSORBS them so the served impl's `AppR` stays clean. */
type CycleCaps = RestateContext | ObjectKey | StateRead | StateWrite

/**
 * The user's per-cycle work. `key` is the scheduled-instance id, `iteration` the
 * 0-based cycle number, `state` the typed K/V State the cycle may read/write for
 * its OWN domain cursor (separate from the control plane).
 *
 * Return `{ stop: true }` to END the loop cleanly from inside the cycle (the
 * data-driven stop condition — the most ergonomic place to decide "no more work",
 * since the cycle already has the data). Return `{ stop: false }` or `void` to
 * continue.
 *
 * The cycle's `E` is the CLEAN `RestateError` channel (decision 0003); domain
 * failures should be caught inside the cycle and folded into the return / state.
 * A failure that escapes is governed by `onCycleError`.
 */
export type CycleEffect<
  DomainState extends Record<string, Schema.Schema<any, any>>,
  AppR,
> = (args: {
  readonly key: string
  readonly iteration: number
  readonly state: ReturnType<typeof stateFor<DomainState>>
}) => Effect.Effect<{ readonly stop?: boolean } | void, RestateError, AppR | CycleCaps>

export interface ScheduledConfig<
  DomainState extends Record<string, Schema.Schema<any, any>>,
  AppR,
> {
  /** The Object name (the materialized service name). */
  readonly name: string
  /** The user's domain State schema (the cursor etc.); merged with the control plane. */
  readonly domainState: DomainState
  /** One cycle of work. */
  readonly cycle: CycleEffect<DomainState, AppR>
  /** The schedule shape (v1: `Schedule.fixedDelay(ms)`). */
  readonly schedule: Schedule
  /** Per-cycle error policy. DEFAULT: `skipToNext`. */
  readonly onCycleError?: OnCycleError
  /**
   * Stop the loop when this predicate over the (next) iteration count returns
   * true. The cycle-body `{ stop: true }` return is the data-driven counterpart.
   */
  readonly stopWhen?: (iteration: number) => boolean
  /** Cap the number of cycles (sugar over `stopWhen`). */
  readonly maxIterations?: number
}

/**
 * The result of `make`: the bound Object implementation to serve, plus the
 * contract so a caller can drive the `start`/`stop`/`status` control handlers via
 * the typed ingress / in-handler object clients.
 */
export interface Scheduled<AppR> {
  readonly contract: ReturnType<typeof buildContract>
  readonly implementation: AnyImplementation<AppR>
}

/* The contract shape is fixed regardless of the runtime domain state (the
 * control-plane handlers are fixed); domain typing rides on the `make` generic.
 * The `cycle` handler is `ingressPrivate` — only the Object's own (delayed)
 * self-send may invoke it, never an external caller. */
const buildContract = (name: string) =>
  RestateObject.contract(name, {
    state: ControlState,
    handlers: {
      /** Start (or restart) the loop: bump generation, reset the counter, arm cycle 0. */
      start: { input: Schema.Void, success: Schema.Boolean },
      /** Stop the loop: flip status to `stopped`; the in-flight re-arm no-ops. */
      stop: { input: Schema.Void, success: Schema.Boolean },
      /** Read-only status (SHARED handler — no write lock, safe to poll). */
      status: { input: Schema.Void, success: StatusOutput, shared: true },
      /**
       * INTERNAL: one cycle. `ingressPrivate` so it is NOT callable from outside
       * the cluster — only the Object's own re-arm send (and the initial `start`
       * arm) may invoke it. This is the chain-of-self-sends body.
       */
      cycle: { input: CycleInput, success: Schema.Void, options: { ingressPrivate: true } },
    },
  })

/** The classified result of running one cycle under the error policy. */
type CycleOutcome =
  | { readonly _tag: 'ok'; readonly stop: boolean }
  | { readonly _tag: 'skipped'; readonly error: string }
  | { readonly _tag: 'failed'; readonly error: string }

const errStr = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e)

/** A human-readable string for a caught Cause (the squashed failure/defect). */
const causeStr = (cause: Cause.Cause<unknown>): string => errStr(Cause.squash(cause))

const isStop = (r: { readonly stop?: boolean } | void): boolean =>
  typeof r === 'object' && r !== null && r.stop === true

export const RestateScheduled = {
  Schedule,
  OnCycleError,
  /**
   * Build a durable recurring loop as a Virtual Object. `AppR` is the explicit app
   * environment the served runtime satisfies (decision 0002 mirror).
   */
  make: <DomainState extends Record<string, Schema.Schema<any, any>>, AppR = never>(
    config: ScheduledConfig<DomainState, AppR>,
  ): Scheduled<AppR> => {
    const onError: OnCycleError = config.onCycleError ?? OnCycleError.skipToNext()
    const contract = buildContract(config.name)
    const Ctrl = stateFor(ControlState)
    const Domain = stateFor(config.domainState)
    const delayMillis = config.schedule.delayMillis

    /* The count-driven stop condition: explicit `stopWhen` OR `maxIterations`. */
    const stopByCount = (iteration: number): boolean =>
      (config.stopWhen?.(iteration) ?? false) ||
      (config.maxIterations !== undefined && iteration >= config.maxIterations)

    /* Self re-arm: a DELAYED send to our OWN `cycle` handler on the same key,
     * carrying the generation we armed under (so a stale re-arm no-ops). */
    const armNext = (generation: number, delay: number) =>
      reschedule({ contract, method: 'cycle', input: { generation }, delayMillis: delay })

    /* eslint-disable-next-line @typescript-eslint/no-explicit-any -- materialization glue; the public make signature stays typed */
    const impl: any = {
      start: () =>
        Effect.gen(function* () {
          const nextGen = ((yield* Ctrl.get('generation')) ?? 0) + 1
          yield* Ctrl.set('status', 'running')
          yield* Ctrl.set('iteration', 0)
          yield* Ctrl.set('generation', nextGen)
          yield* Ctrl.clear('lastError')
          /* Arm cycle 0 immediately (delay 0) under the new generation. */
          yield* armNext(nextGen, 0)
          return true
        }).pipe(Effect.orDie),

      stop: () =>
        Effect.gen(function* () {
          /* Flip status; the pending delayed `cycle` send will land and no-op
           * because the `running` guard fails. We do NOT cancel the timer. */
          yield* Ctrl.set('status', 'stopped')
          return true
        }).pipe(Effect.orDie),

      status: () =>
        Effect.gen(function* () {
          const status = (yield* Ctrl.get('status')) ?? 'idle'
          const iteration = (yield* Ctrl.get('iteration')) ?? 0
          const lastError = yield* Ctrl.get('lastError')
          return { status, iteration, ...(lastError !== undefined ? { lastError } : {}) }
        }).pipe(Effect.orDie),

      cycle: (input: CycleInput) =>
        Effect.gen(function* () {
          const key = yield* objectKey
          const liveGen = (yield* Ctrl.get('generation')) ?? 0
          const status = (yield* Ctrl.get('status')) ?? 'idle'

          /* GUARD: only run if this send's generation is still current AND the loop
           * is running. A stale re-arm (after stop / restart) no-ops. This is the
           * idempotency + overlap-prevention seam. */
          if (input.generation !== liveGen || status !== 'running') return

          const iteration = (yield* Ctrl.get('iteration')) ?? 0

          /* Count-driven stop BEFORE doing any work. */
          if (stopByCount(iteration)) {
            yield* Ctrl.set('status', 'completed')
            return
          }

          /* SAFE ORDERING: advance the counter AND re-arm the next cycle FIRST
           * (both journaled), THEN run the user's fallible work. A re-arm journaled
           * before a later failure is still delivered, so the loop SURVIVES a
           * failing cycle even under a terminal failure or a kill — the next cycle
           * is already enqueued. If the cycle ends the loop (stop / count), we flip
           * status so the already-armed next cycle lands and no-ops via the guard
           * above (the generation token + status are how we "cancel" it without a
           * timer handle). */
          const nextIteration = iteration + 1
          yield* Ctrl.set('iteration', nextIteration)
          yield* armNext(liveGen, delayMillis)

          const cycleEffect = config.cycle({
            key,
            iteration,
            state: Domain as never,
          }) as Effect.Effect<{ readonly stop?: boolean } | void, RestateError, RestateContext>

          /* Apply the error policy. We catch the FULL cause (failures AND defects),
           * not just the typed `E`: a cycle's bounded `Restate.run` give-up is a
           * `RestateError` DEFECT (clean `E`, decision 0003), so `catchAll` alone
           * would miss it. `skipToNext` swallows it (the loop already re-armed, so
           * it continues); `stopLoop` flips status to `failed` (the already-armed
           * next cycle then no-ops via the guard). An INTERRUPT (suspension /
           * cancellation) is re-raised so Restate's replay/cancel semantics stand —
           * it is not a cycle failure. */
          const outcome: CycleOutcome = yield* cycleEffect.pipe(
            Effect.map((r): CycleOutcome => ({ _tag: 'ok', stop: isStop(r) })),
            Effect.catchAllCause((cause) =>
              Cause.isInterruptedOnly(cause) === true
                ? Effect.failCause(cause)
                : Effect.succeed<CycleOutcome>(
                    onError._tag === 'stopLoop'
                      ? { _tag: 'failed', error: causeStr(cause) }
                      : { _tag: 'skipped', error: causeStr(cause) },
                  ),
            ),
          )

          /* AUTO baseline metric (decision 0014): one cycle executed, by loop name
           * and cycle outcome (`ok` | `error` | `stopped`). Gated on non-replay so
           * a replayed cycle is not re-counted. A data/count-driven stop is folded
           * into `stopped`; `skipped`/`failed` both read as `error`. */
          const ctx = yield* RestateContext
          const cycleStops =
            outcome._tag === 'ok' && (outcome.stop === true || stopByCount(nextIteration))
          const cycleMetricOutcome: 'ok' | 'error' | 'stopped' =
            outcome._tag === 'ok' ? (cycleStops ? 'stopped' : 'ok') : 'error'
          yield* emitPollLoopCycle(ctx, { name: config.name, outcome: cycleMetricOutcome })

          if (outcome._tag === 'failed') {
            yield* Ctrl.set('status', 'failed')
            yield* Ctrl.set('lastError', outcome.error)
            return
          }
          if (outcome._tag === 'skipped') {
            yield* Ctrl.set('lastError', outcome.error)
            return
          }
          /* Success: clear any prior error. */
          yield* Ctrl.clear('lastError')

          /* Data-driven stop from inside the cycle. */
          if (outcome.stop === true) {
            yield* Ctrl.set('status', 'completed')
            return
          }
          /* Count-driven stop AFTER the cycle (so `maxIterations: N` runs N cycles). */
          if (stopByCount(nextIteration)) {
            yield* Ctrl.set('status', 'completed')
          }
        }).pipe(Effect.orDie),
    }

    const implementation = RestateObject.implement<typeof contract, AppR>(
      contract,
      impl,
    ) as unknown as AnyImplementation<AppR>

    return { contract, implementation }
  },
} as const

/** `Restate.pollLoop` — the alias under the `Restate` namespace for discoverability. */
export const pollLoop = RestateScheduled.make
