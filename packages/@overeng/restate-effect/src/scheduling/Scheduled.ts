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
 * ── Scope and deferred knobs ──────────────────────────────────────────────
 * Shipped: `fixedDelay` scheduling, `onCycleError` (default `skipToNext`), stop
 * via `stopWhen` / `maxIterations` / in-cycle `{ stop: true }`, generation-token
 * re-arm, and the SAFE re-arm-BEFORE-fallible-work ordering. Composed (decision
 * 0012): a declared `errorSchema` routes a cycle failure through the boundary's
 * `classifyOutcome`, so a `retryable` error RE-ARMS after its projected
 * `retryAfter` floor (cursor + iteration frozen), bounded by `maxRetryBackoffs`;
 * and `wake` opts the inter-cycle wait into an AWAKEABLE-woken `race`, so an
 * external webhook can cut the wait short. DEFERRED as documented non-goals (see
 * decision 0012): `fixedRate`, `cron`, and runtime `reconfigure`. There is
 * intentionally NO primitive-level `retryCycle` knob — per-cycle durable retry
 * belongs INSIDE the cycle's BOUNDED `Restate.run`.
 *
 * ── Two loop shapes (no-wake delayed-send vs wake held-race) ──────────────
 * The shapes differ enough that `make` materializes two distinct `cycle` bodies:
 *
 *   - NO wake (default, WEDGE-FREE) — each cycle does work then re-arms via a
 *     DELAYED self-send and RETURNS; the per-key write lock is RELEASED between
 *     cycles, so an exclusive `stop`/`start` is never queued behind a backoff. A
 *     `retryable` re-arm bumps the generation and arms a FRESH `retryAfter` send so
 *     the already-armed `delayMillis` send lands and no-ops via the generation
 *     guard.
 *   - wake ON — the inter-cycle wait moves INSIDE the invocation as
 *     `Restate.race([sleepDescriptor(delay), wake.descriptor])`; on wake the next
 *     cycle re-arms with delay 0. The lock IS HELD during the wait, so exclusive
 *     `stop`/`start` queue behind it (bounded by the sleep leg). PAIR wake with
 *     SHORT `retryAfter` floors so a held backoff cannot delay `stop` for long.
 */
import { Cause, Effect, Schema } from 'effect'

import type { ObjectKey, StateRead, StateWrite } from '../authoring/RestateContext.ts'
import {
  makeAwakeable,
  objectKey,
  race,
  RestateContext,
  sleepDescriptor,
  stateFor,
} from '../authoring/RestateContext.ts'
import { RestateObject } from '../authoring/Service.ts'
import { type AnyImplementation } from '../endpoint/Endpoint.ts'
import { classifyOutcome } from '../error/Boundary.ts'
import { emitPollLoopCycle } from '../observability/Metrics.ts'
import { readErrorClass } from '../schema/Annotations.ts'
import type { RestateError } from '../schema/RestateError.ts'
import { reschedule } from './Reschedule.ts'

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
 * A `retryable`-annotated failure (declared via `errorSchema`) is handled BEFORE
 * this policy: it re-arms after its `retryAfter` floor (see `errorSchema` /
 * `maxRetryBackoffs`). The policy governs only `terminal`/defect/give-up failures.
 *
 * NOTE: there is no `retryCycle` option. To durably retry the work itself, bound
 * a `Restate.run(name, action, { maxRetryAttempts })` INSIDE the cycle (the only
 * place that honestly re-executes). An UNBOUNDED `Restate.run` retries forever and
 * wedges the per-key write lock so `stop` cannot run — always bound it (see
 * decision 0012).
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

/**
 * The wake payload (decision 0012). When `wake` is enabled the loop opens an
 * awakeable per cycle; an external webhook resolves it via ingress
 * `resolveAwakeable` with this payload to cut the inter-cycle wait short. The
 * `reason` is threaded into the NEXT cycle as `wokenBy` (a one-shot signal).
 */
export const WakePayload = Schema.Struct({ reason: Schema.String })
export type WakePayload = Schema.Schema.Type<typeof WakePayload>

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
   * us no timer handle). A `retryable` re-arm also bumps it so the pre-armed
   * `delayMillis` send no-ops and only the fresh `retryAfter` send lands.
   */
  generation: Schema.Number,
  /** Last cycle error string (for `skipToNext`/`failed`/retry diagnostics). */
  lastError: Schema.String,
  /**
   * Consecutive `retryable` backoffs for the CURRENT logical cycle (reset to 0 on
   * a successful / skipped / advancing cycle). Surfaced in `status` so an operator
   * can see a backoff is active; bounds the re-arm via `maxRetryBackoffs`.
   */
  retryBackoffs: Schema.Number,
  /**
   * The awakeable id of the CURRENT inter-cycle wait (wake mode), persisted so an
   * external caller (the webhook) can read it via the `wakeId` SHARED handler and
   * `resolveAwakeable` it. ROTATED every cycle; cleared when no wait is live. A
   * stale id resolves harmlessly (its awakeable belongs to a completed invocation).
   */
  wakeId: Schema.String,
  /**
   * The one-shot reason a wait was woken early (wake mode), recorded by the wait
   * that observed the awakeable resolution and consumed by the NEXT cycle body
   * (`args.wokenBy`). Cleared after the next cycle reads it.
   */
  wokenByReason: Schema.String,
} as const

/** The cycle input the internal `cycle` handler is sent (carries the generation). */
const CycleInput = Schema.Struct({ generation: Schema.Number })
type CycleInput = Schema.Schema.Type<typeof CycleInput>

/** The status the `status` shared handler returns. */
const StatusOutput = Schema.Struct({
  status: StatusSchema,
  iteration: Schema.Number,
  lastError: Schema.optional(Schema.String),
  /** Consecutive retryable backoffs for the current logical cycle (0 when none). */
  retryBackoffs: Schema.Number,
  /** The live wake awakeable id (wake mode); omitted when no wait is live. */
  wakeId: Schema.optional(Schema.String),
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
 * its OWN domain cursor (separate from the control plane). `wokenBy` is set (wake
 * mode only) when the PREVIOUS inter-cycle wait was cut short by an awakeable
 * resolution — the cycle can branch on "woke early for X".
 *
 * Return `{ stop: true }` to END the loop cleanly from inside the cycle (the
 * data-driven stop condition — the most ergonomic place to decide "no more work",
 * since the cycle already has the data). Return `{ stop: false }` or `void` to
 * continue.
 *
 * The cycle's `E` is the CLEAN `RestateError` channel (decision 0003). A declared
 * domain failure (when `errorSchema` is given) that ESCAPES is classified at the
 * loop boundary: a `retryable` member re-arms after `retryAfter`; a `terminal`
 * member / defect is governed by `onCycleError`.
 */
export type CycleEffect<
  DomainState extends Record<string, Schema.Schema<any, any>>,
  AppR,
> = (args: {
  readonly key: string
  readonly iteration: number
  readonly state: ReturnType<typeof stateFor<DomainState>>
  readonly wokenBy?: WakePayload
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
  /**
   * The cycle's declared error union (a `Schema.TaggedError` / `Schema.Union` of
   * such, annotated with `Restate.retryable(...)` / `Restate.terminal(...)`).
   * Routed through the boundary's `classifyOutcome`, so a `retryable` failure
   * re-arms the NEXT cycle after its projected `retryAfter` floor (cursor +
   * iteration FROZEN — the SAME logical cycle retries) instead of advancing. When
   * absent, every cycle failure is `terminal`/defect and the `onCycleError` policy
   * governs it (full back-compat).
   */
  readonly errorSchema?: Schema.Schema<any, any>
  /**
   * Cap consecutive `retryable` backoffs for ONE logical cycle. Past the cap the
   * retryable failure is DEMOTED to the `onCycleError` policy (so a permanently-429
   * source eventually skips/stops instead of backing off forever). DEFAULT:
   * unbounded (back off every cycle — still stoppable in the no-wake shape).
   */
  readonly maxRetryBackoffs?: number
  /**
   * Enable the awakeable WAKE trigger. When true, each inter-cycle wait is
   * `Restate.race([sleepDescriptor(delay), wake.descriptor])` and the loop persists
   * the live awakeable id (`wakeId`, readable via the SHARED `wakeId` handler) so an
   * external webhook can resolve it and fire the next cycle EARLY. When false/absent
   * (DEFAULT) the loop is the WEDGE-FREE delayed-send shape (no held wait).
   *
   * TRADEOFF: wake mode HOLDS the per-key write lock during the inter-cycle wait,
   * so an exclusive `stop`/`start` queues behind it (bounded by the sleep leg). Pair
   * wake with SHORT `retryAfter` floors; the no-wake shape never holds the lock.
   */
  readonly wake?: boolean
}

/**
 * The result of `make`: the bound Object implementation to serve, plus the
 * contract so a caller can drive the `start`/`stop`/`status`/`wakeId` control
 * handlers via the typed ingress / in-handler object clients.
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
       * Read the live wake awakeable id (SHARED — no write lock, so the webhook can
       * read it even while an exclusive cycle holds the lock). Empty string when no
       * wait is live (or wake is disabled). Wake mode only.
       */
      wakeId: { input: Schema.Void, success: Schema.String, shared: true },
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
  /** A `retryable` error → re-arm after `retryAfterMillis` WITHOUT advancing
   * cursor/iteration (the same logical cycle retries). */
  | { readonly _tag: 'retry'; readonly error: string; readonly retryAfterMillis: number }

const errStr = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e)

/** A human-readable string for a caught Cause (the squashed failure/defect). */
const causeStr = (cause: Cause.Cause<unknown>): string => errStr(Cause.squash(cause))

const isStop = (r: { readonly stop?: boolean } | void): boolean =>
  typeof r === 'object' && r !== null && r.stop === true

/**
 * Whether the declared `errorSchema` carries ANY `retryable` annotation (the union
 * member or the schema itself). Read ONCE at `make`: when no member is retryable,
 * the loop never needs to project a `retryAfter` and the classification is a pure
 * `onCycleError` decision — keeps the cycle body honest about whether the retry
 * re-arm path can ever fire.
 */
const hasRetryableMember = (errorSchema: Schema.Schema<any, any> | undefined): boolean => {
  if (errorSchema === undefined) return false
  const ast = errorSchema.ast
  const members = ast._tag === 'Union' ? ast.types : [ast]
  return members.some((m) => {
    const cls = readErrorClass(m)
    return cls._tag === 'Some' && cls.value._tag === 'retryable'
  })
}

/**
 * The projected `retryAfter` millis a `retryable` outcome carries. The boundary's
 * `classifyOutcome` projects it onto the thrown `RetryableError` (the SDK's
 * `retryAfter`), so reading it back off that throw makes the SAME projection the
 * source of truth for BOTH the boundary AND the loop's re-arm delay. Falls back to
 * `undefined` (→ the schedule delay) when the error declares no floor.
 */
const retryAfterOf = (thrown: unknown): number | undefined => {
  if (typeof thrown !== 'object' || thrown === null) return undefined
  const ra = (thrown as { retryAfter?: unknown }).retryAfter
  return typeof ra === 'number' ? ra : undefined
}

export const RestateScheduled = {
  Schedule,
  OnCycleError,
  WakePayload,
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
    const wakeOn = config.wake === true
    const errorSchema = config.errorSchema
    const maxRetryBackoffs = config.maxRetryBackoffs
    const retryable = hasRetryableMember(errorSchema)

    /* The count-driven stop condition: explicit `stopWhen` OR `maxIterations`. */
    const stopByCount = (iteration: number): boolean =>
      (config.stopWhen?.(iteration) ?? false) ||
      (config.maxIterations !== undefined && iteration >= config.maxIterations)

    /* Self re-arm: a DELAYED send to our OWN `cycle` handler on the same key,
     * carrying the generation we armed under (so a stale re-arm no-ops). */
    const armNext = (generation: number, delay: number) =>
      reschedule({ contract, method: 'cycle', input: { generation }, delayMillis: delay })

    /* Classify the cycle's failure cause through the boundary's single source of
     * truth (`classifyOutcome`, which resolves the matching union member). A
     * `retryable` outcome (within the optional backoff cap) becomes a `retry`
     * carrying its projected `retryAfter`; everything else (terminal / defect /
     * give-up) hits the `onCycleError` policy. Only reached when `retryable` is true
     * (else the caller short-circuits to the policy). */
    const classifyCycleFailure = (
      cause: Cause.Cause<unknown>,
      backoffsSoFar: number,
    ): CycleOutcome => {
      const outcome = classifyOutcome(cause, errorSchema)
      if (outcome._tag === 'retryable') {
        /* Past the (optional) backoff cap → demote to the count-based policy. */
        if (maxRetryBackoffs !== undefined && backoffsSoFar >= maxRetryBackoffs) {
          return onError._tag === 'stopLoop'
            ? { _tag: 'failed', error: causeStr(cause) }
            : { _tag: 'skipped', error: causeStr(cause) }
        }
        return {
          _tag: 'retry',
          error: causeStr(cause),
          retryAfterMillis: retryAfterOf(outcome.thrown) ?? delayMillis,
        }
      }
      return onError._tag === 'stopLoop'
        ? { _tag: 'failed', error: causeStr(cause) }
        : { _tag: 'skipped', error: causeStr(cause) }
    }

    /* Run the user's cycle and classify its exit into a `CycleOutcome`. An interrupt
     * (suspension / cancellation) is RE-RAISED so Restate's replay/cancel semantics
     * stand — it is not a cycle failure. When `retryable` is false the failure
     * skips the boundary classification (no retry path can fire) and goes straight
     * to the policy — matching the legacy no-`errorSchema` behavior exactly. */
    const runCycle = (
      args: Parameters<CycleEffect<DomainState, AppR>>[0],
      backoffsSoFar: number,
    ): Effect.Effect<CycleOutcome, never, AppR | CycleCaps> => {
      const cycleEffect = config.cycle(args) as Effect.Effect<
        { readonly stop?: boolean } | void,
        RestateError,
        RestateContext
      >
      return cycleEffect.pipe(
        Effect.map((r): CycleOutcome => ({ _tag: 'ok', stop: isStop(r) })),
        Effect.catchAllCause((cause) =>
          Cause.isInterruptedOnly(cause) === true
            ? Effect.failCause(cause)
            : Effect.succeed(
                retryable
                  ? classifyCycleFailure(cause, backoffsSoFar)
                  : ((onError._tag === 'stopLoop'
                      ? { _tag: 'failed', error: causeStr(cause) }
                      : { _tag: 'skipped', error: causeStr(cause) }) as CycleOutcome),
              ),
        ),
      ) as Effect.Effect<CycleOutcome, never, AppR | CycleCaps>
    }

    /* AUTO baseline metric (decision 0014): one cycle executed, by loop name and
     * outcome (`ok` | `error` | `stopped`). Gated on non-replay (inside `emit`) so a
     * replayed cycle is not re-counted. A retry / skip / failure all read as
     * `error`; a data/count-driven stop reads as `stopped`. */
    const emitCycle = (outcome: CycleOutcome, stops: boolean) =>
      Effect.gen(function* () {
        const ctx = yield* RestateContext
        const metricOutcome: 'ok' | 'error' | 'stopped' =
          outcome._tag === 'ok' ? (stops ? 'stopped' : 'ok') : 'error'
        yield* emitPollLoopCycle(ctx, { name: config.name, outcome: metricOutcome })
      })

    /* eslint-disable-next-line @typescript-eslint/no-explicit-any -- materialization glue; the public make signature stays typed */
    const impl: any = {
      start: () =>
        Effect.gen(function* () {
          const nextGen = ((yield* Ctrl.get('generation')) ?? 0) + 1
          yield* Ctrl.set('status', 'running')
          yield* Ctrl.set('iteration', 0)
          yield* Ctrl.set('generation', nextGen)
          yield* Ctrl.set('retryBackoffs', 0)
          yield* Ctrl.clear('lastError')
          yield* Ctrl.clear('wakeId')
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
          const retryBackoffs = (yield* Ctrl.get('retryBackoffs')) ?? 0
          const wakeId = yield* Ctrl.get('wakeId')
          return {
            status,
            iteration,
            retryBackoffs,
            ...(lastError !== undefined ? { lastError } : {}),
            ...(wakeId !== undefined && wakeId !== '' ? { wakeId } : {}),
          }
        }).pipe(Effect.orDie),

      wakeId: () =>
        Effect.gen(function* () {
          return (yield* Ctrl.get('wakeId')) ?? ''
        }).pipe(Effect.orDie),

      cycle: (input: CycleInput) =>
        Effect.gen(function* () {
          const key = yield* objectKey
          const liveGen = (yield* Ctrl.get('generation')) ?? 0
          const status = (yield* Ctrl.get('status')) ?? 'idle'

          /* GUARD: only run if this send's generation is still current AND the loop
           * is running. A stale re-arm (after stop / restart / a retryable
           * re-arm bump) no-ops. This is the idempotency + overlap-prevention seam. */
          if (input.generation !== liveGen || status !== 'running') return

          const iteration = (yield* Ctrl.get('iteration')) ?? 0
          const backoffsSoFar = (yield* Ctrl.get('retryBackoffs')) ?? 0

          /* Count-driven stop BEFORE doing any work. */
          if (stopByCount(iteration)) {
            yield* Ctrl.set('status', 'completed')
            yield* Ctrl.clear('wakeId')
            return
          }

          const nextIteration = iteration + 1

          if (!wakeOn) {
            /* ── NO-WAKE BODY (wedge-free delayed self-send) ─────────────────────
             * SAFE ORDERING: advance the counter AND re-arm the next cycle FIRST
             * (both journaled), THEN run the user's fallible work. A re-arm journaled
             * before a later failure is still delivered, so the loop SURVIVES a
             * failing cycle even under a terminal failure or a kill — the next cycle
             * is already enqueued. */
            yield* Ctrl.set('iteration', nextIteration)
            yield* armNext(liveGen, delayMillis)

            const outcome = yield* runCycle(
              { key, iteration, state: Domain as never },
              backoffsSoFar,
            )

            const stops =
              outcome._tag === 'ok' && (outcome.stop === true || stopByCount(nextIteration))
            yield* emitCycle(outcome, stops)

            if (outcome._tag === 'retry') {
              /* RETRY: the pre-armed `delayMillis` send is WRONG (we want
               * `retryAfter`, cursor + iteration unchanged). We cannot un-send it, so
               * roll back the iteration bump and BUMP the generation so the
               * already-armed `delayMillis` send no-ops, then arm a FRESH
               * `retryAfter` send under the new generation. The lock is RELEASED
               * during the backoff (delayed send) — `stop` is never wedged. */
              const retryGen = liveGen + 1
              yield* Ctrl.set('generation', retryGen)
              yield* Ctrl.set('iteration', iteration) // undo the bump (same logical cycle)
              yield* Ctrl.set('retryBackoffs', backoffsSoFar + 1)
              yield* Ctrl.set('lastError', outcome.error)
              yield* armNext(retryGen, outcome.retryAfterMillis)
              return
            }

            /* Non-retry: reset the backoff counter (this logical cycle resolved). */
            if (backoffsSoFar !== 0) yield* Ctrl.set('retryBackoffs', 0)

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
            if (outcome.stop === true) {
              yield* Ctrl.set('status', 'completed')
              return
            }
            if (stopByCount(nextIteration)) {
              yield* Ctrl.set('status', 'completed')
            }
            return
          }

          /* ── WAKE BODY (held race; lock held during the inter-cycle wait) ───────
           * We CANNOT pre-arm a delayed send AND hold a race (that double-fires), so
           * the re-arm happens AFTER the held race. Durability here relies on the
           * held race (the awaited race is journaled — on replay the wait re-issues)
           * + the persisted generation. Open a fresh wake awakeable for THIS cycle's
           * wait and persist its id BEFORE running work, so the webhook can resolve
           * it as soon as the cycle is live; the id is ROTATED every cycle. */
          const aw = yield* makeAwakeable(WakePayload)
          yield* Ctrl.set('wakeId', aw.id)

          /* Read + consume the one-shot `wokenByReason` recorded by the prior wait. */
          const wokenByReason = yield* Ctrl.get('wokenByReason')
          if (wokenByReason !== undefined) yield* Ctrl.clear('wokenByReason')

          yield* Ctrl.set('iteration', nextIteration)

          const outcome = yield* runCycle(
            {
              key,
              iteration,
              state: Domain as never,
              ...(wokenByReason !== undefined ? { wokenBy: { reason: wokenByReason } } : {}),
            },
            backoffsSoFar,
          )

          const stops =
            outcome._tag === 'ok' && (outcome.stop === true || stopByCount(nextIteration))
          yield* emitCycle(outcome, stops)

          /* Terminal outcomes end the loop before the held wait. */
          if (outcome._tag === 'failed') {
            yield* Ctrl.set('status', 'failed')
            yield* Ctrl.set('lastError', outcome.error)
            yield* Ctrl.clear('wakeId')
            return
          }
          if (stops) {
            yield* Ctrl.set('status', 'completed')
            yield* Ctrl.clear('wakeId')
            return
          }

          /* Determine the inter-cycle wait + bookkeeping per outcome. */
          let waitMillis = delayMillis
          if (outcome._tag === 'retry') {
            /* RETRY+WAKE: back off for `retryAfter`, cursor + iteration unchanged.
             * The held race honors `retryAfter` as the sleep leg but remains wakeable
             * (a webhook can still cut the backoff short). */
            waitMillis = outcome.retryAfterMillis
            yield* Ctrl.set('iteration', iteration) // undo bump (same logical cycle)
            yield* Ctrl.set('retryBackoffs', backoffsSoFar + 1)
            yield* Ctrl.set('lastError', outcome.error)
          } else if (outcome._tag === 'skipped') {
            if (backoffsSoFar !== 0) yield* Ctrl.set('retryBackoffs', 0)
            yield* Ctrl.set('lastError', outcome.error)
          } else {
            if (backoffsSoFar !== 0) yield* Ctrl.set('retryBackoffs', 0)
            yield* Ctrl.clear('lastError')
          }

          /* HELD RACE: sleep(waitMillis) vs the wake awakeable. Whichever resolves
           * first ends the wait; then re-arm the next cycle with delay 0. */
          const raced = yield* race([
            sleepDescriptor(waitMillis, 'inter-cycle'),
            aw.descriptor,
          ]) as Effect.Effect<unknown, never, RestateContext>

          /* If the awakeable resolved, `raced` is the WakePayload; if the timer
           * fired, it is `undefined` (sleep returns void). Persist the wokenBy reason
           * for the NEXT cycle (one-shot), then clear the live wakeId. */
          const wokenBy =
            typeof raced === 'object' && raced !== null && 'reason' in (raced as object)
              ? (raced as WakePayload)
              : undefined
          if (wokenBy !== undefined) yield* Ctrl.set('wokenByReason', wokenBy.reason)
          yield* Ctrl.clear('wakeId')

          /* Re-arm the next cycle immediately (delay 0) under the SAME generation. */
          yield* armNext(liveGen, 0)
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
