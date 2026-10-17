import { Deferred, Effect, Exit, Ref, Schema, Scope } from 'effect'

import type { Retention, Sample, Series, SeriesSnapshot, SeriesStore } from '../series/index.ts'
import type { FrameClock } from '../session/clock.ts'
import type { FrameStats } from '../session/frame.ts'
import type { SourceEvidence } from '../session/source.ts'
import { frameState, frameSupport, visibility } from '../session/types.ts'

/** Revision-stable current session evidence; arbitrary series remain typed reads. */
export interface Snapshot {
  readonly sessionId: string
  readonly generation: number
  readonly timeOriginMs: number
  readonly atMs: number
  readonly frames: Sample<FrameStats>
  readonly retention: readonly { readonly id: string; readonly range: Retention }[]
  readonly counters: Readonly<Record<string, number>>
}
/** Scope-owned executable authority; a valid end consumes it exactly once. */
export interface Measurement {
  readonly end: (options?: {
    readonly settleFrames?: number
  }) => Effect.Effect<MeasureResult, MeasureError>
}
/** Reasons retained across resume, recovery, and ring eviction. */
export const IncompleteReason = Schema.Literals([
  'Hidden',
  'CalibrationInvalid',
  'Stopped',
  'NoSamples',
  'NotConfigured',
  'HistoryLost',
  'ObservationLost',
]).annotate({ identifier: 'Meters.IncompleteReason' })
/** Ineligibility reason decoded from measurement evidence. */
export type IncompleteReason = typeof IncompleteReason.Type
/** Visible-frame settlement option shared by scoped and work brackets. */
export const SettlementFrames = Schema.Natural.annotate({ identifier: 'Meters.SettlementFrames' })
/** Eligible bracket-scoped cumulative deltas, not trailing statistics. */
export const CompleteData = Schema.Struct({
  durationMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  framesCaptured: Schema.Natural,
  frameDrops: Schema.Natural,
  averageFps: Schema.Natural,
  counterDelta: Schema.Record(Schema.String, Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
})
/** Eligible cumulative data. */
export type CompleteData = typeof CompleteData.Type
/** Truthful partial evidence for an ineligible measurement. */
export const PartialData = Schema.Struct({
  durationMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  framesCaptured: Schema.Natural,
  frameDrops: Schema.Union([
    Schema.TaggedStruct('Value', {
      atMs: Schema.Finite,
      value: Schema.TaggedStruct('Number', { value: Schema.Finite }),
    }),
    Schema.TaggedStruct('Unavailable', {
      atMs: Schema.Finite,
      reason: Schema.Literals([
        'Unsupported',
        'NotConfigured',
        'NotIsolated',
        'PermissionDenied',
        'MeasurementFailed',
        'NoSamples',
        'Hidden',
        'HistoryLost',
        'CalibrationInvalid',
        'Stopped',
        'Stale',
        'Disconnected',
      ]),
      lastKnown: Schema.optionalKey(
        Schema.Struct({
          atMs: Schema.Finite,
          value: Schema.TaggedStruct('Number', { value: Schema.Finite }),
        }),
      ),
    }),
    Schema.TaggedStruct('Gap', {
      atMs: Schema.Finite,
      durationMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
      reason: Schema.Literals(['MissedFrame', 'Hidden', 'Overflow']),
    }),
  ]),
  averageFps: Schema.Union([
    Schema.TaggedStruct('Value', {
      atMs: Schema.Finite,
      value: Schema.TaggedStruct('Number', { value: Schema.Finite }),
    }),
    Schema.TaggedStruct('Unavailable', {
      atMs: Schema.Finite,
      reason: Schema.Literals([
        'Unsupported',
        'NotConfigured',
        'NotIsolated',
        'PermissionDenied',
        'MeasurementFailed',
        'NoSamples',
        'Hidden',
        'HistoryLost',
        'CalibrationInvalid',
        'Stopped',
        'Stale',
        'Disconnected',
      ]),
      lastKnown: Schema.optionalKey(
        Schema.Struct({
          atMs: Schema.Finite,
          value: Schema.TaggedStruct('Number', { value: Schema.Finite }),
        }),
      ),
    }),
    Schema.TaggedStruct('Gap', {
      atMs: Schema.Finite,
      durationMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
      reason: Schema.Literals(['MissedFrame', 'Hidden', 'Overflow']),
    }),
  ]),
  counterDelta: Schema.Record(Schema.String, Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
})
/** Partial cumulative data. */
export type PartialData = typeof PartialData.Type
/** Schema-encoded results; only Complete measurements are eligible for gates. */
export const MeasureResult = Schema.Union([
  Schema.TaggedStruct('Complete', { eligible: Schema.Literal(true), data: CompleteData }),
  Schema.TaggedStruct('Incomplete', {
    eligible: Schema.Literal(false),
    reasons: Schema.NonEmptyArray(IncompleteReason),
    data: PartialData,
  }),
]).annotate({ identifier: 'Meters.MeasureResult' })
/** Decoded measurement result. */
export type MeasureResult = typeof MeasureResult.Type
/** Explicit lifecycle or settlement validation failure. */
export class MeasureError extends Schema.TaggedError<MeasureError>()(
  'MeasureError',
  {
    reason: Schema.Literals([
      'NotRunning',
      'StaleGeneration',
      'AlreadyEnded',
      'ScopeClosed',
      'InvalidOptions',
    ]),
    message: Schema.String,
  },
  { identifier: 'Meters.MeasureError' },
) {}
/** Independent snapshots and scoped split/work brackets. */
export interface Headless {
  readonly snapshot: () => Snapshot
  readonly snapshotSeries: <TValue>(options: {
    readonly series: Series<TValue>
  }) => SeriesSnapshot<TValue>
  readonly measurement: Effect.Effect<Measurement, MeasureError, Scope.Scope>
  readonly measureWindow: <TValue, TError, TEnv>(options: {
    readonly work: Effect.Effect<TValue, TError, TEnv>
    readonly settleFrames?: number
  }) => Effect.Effect<
    { readonly result: TValue; readonly measurement: MeasureResult },
    TError | MeasureError,
    TEnv
  >
}
/** Internal lifecycle markers preserve evidence independently of retained history. */
export interface SessionEvidence {
  running: boolean
  generation: number
  revision: number
  hidden: number
  stopped: number
}
interface Before {
  readonly generation: number
  readonly startedAtMs: number
  readonly captured: number
  readonly skipped: number
  readonly invalid: number
  readonly hidden: number
  readonly stopped: number
  readonly loss: number
  readonly counters: Readonly<Record<string, number>>
  readonly initialReasons: readonly IncompleteReason[]
}
type MeasurementState =
  | { readonly _tag: 'Open'; readonly before: Before }
  | { readonly _tag: 'Frozen'; readonly result: MeasureResult }
  | {
      readonly _tag: 'Settling'
      readonly before: Before
      readonly wake: Deferred.Deferred<MeasureResult, MeasureError>
    }
  | { readonly _tag: 'Ended' | 'Released' | 'Invalidated' }

/** Build the session-owned headless view without installing a bridge or collector. */
export const makeHeadless = (options: {
  readonly sessionId: string
  readonly timeOriginMs: number
  readonly clock: FrameClock
  readonly store: SeriesStore
  readonly session: SessionEvidence
  readonly sources: readonly {
    readonly evidence: SourceEvidence
    readonly retention: () => { readonly id: string; readonly range: Retention }
  }[]
}): {
  readonly headless: Headless
  readonly restart: Effect.Effect<void>
  readonly stop: Effect.Effect<void>
} => {
  const live = new Set<{
    readonly state: Ref.Ref<MeasurementState>
    readonly scope: Scope.Closeable
  }>()
  let cached: Snapshot | undefined
  let cachedKey = ''
  const frames = options.clock[frameState]
  const hasFrames = options.sources.some((source) => source.evidence.frameCapacity !== undefined)
  const counters = (): Readonly<Record<string, number>> =>
    Object.freeze(
      Object.fromEntries(
        options.sources.flatMap((source) => Object.entries(source.evidence.counters?.() ?? {})),
      ),
    )
  const loss = (): number =>
    options.sources.reduce((total, source) => total + (source.evidence.loss?.() ?? 0), 0)
  const capture = ({
    before,
    settlementReason,
  }: {
    readonly before: Before
    readonly settlementReason?: 'Hidden' | 'Stopped'
  }): MeasureResult => {
    const reasons = new Set<IncompleteReason>(before.initialReasons)
    if (settlementReason !== undefined) reasons.add(settlementReason)
    if (options.clock[frameSupport]() === false) reasons.add('NotConfigured')
    const atMs = options.clock.now()
    const durationMs = atMs - before.startedAtMs
    const framesCaptured = frames.captured - before.captured
    const frameDrops = frames.skipped - before.skipped
    if (options.session.hidden !== before.hidden) reasons.add('Hidden')
    if (options.session.stopped !== before.stopped || options.session.running === false)
      reasons.add('Stopped')
    if (frames.invalid !== before.invalid || frames.calibration._tag !== 'Calibrated')
      reasons.add('CalibrationInvalid')
    if (loss() !== before.loss) reasons.add('ObservationLost')
    if (durationMs <= 0 || framesCaptured === 0) reasons.add('NoSamples')
    const counterDelta: Record<string, number> = Object.fromEntries([])
    for (const [id, value] of Object.entries(counters())) {
      const delta =
        value - (Object.hasOwn(before.counters, id) === true ? (before.counters[id] ?? 0) : 0)
      if (delta !== 0) Object.defineProperty(counterDelta, id, { value: delta, enumerable: true })
    }
    Object.freeze(counterDelta)
    const averageFps = durationMs > 0 ? Math.round((framesCaptured * 1000) / durationMs) : 0
    const first = reasons.values().next().value
    if (first === undefined)
      return {
        _tag: 'Complete',
        eligible: true,
        data: { durationMs, framesCaptured, frameDrops, averageFps, counterDelta },
      } satisfies MeasureResult
    const remaining = Array.from(reasons).filter((reason) => reason !== first)
    const data: PartialData = {
      durationMs,
      framesCaptured,
      counterDelta,
      frameDrops:
        reasons.has('CalibrationInvalid') === true || hasFrames === false
          ? {
              _tag: 'Unavailable',
              atMs,
              reason: hasFrames === false ? 'NotConfigured' : 'CalibrationInvalid',
            }
          : { _tag: 'Value', atMs, value: { _tag: 'Number', value: frameDrops } },
      averageFps:
        durationMs <= 0 || framesCaptured === 0 || hasFrames === false
          ? {
              _tag: 'Unavailable',
              atMs,
              reason: hasFrames === false ? 'NotConfigured' : 'NoSamples',
            }
          : { _tag: 'Value', atMs, value: { _tag: 'Number', value: averageFps } },
    }
    return {
      _tag: 'Incomplete',
      eligible: false,
      reasons: [first, ...remaining],
      data,
    } satisfies MeasureResult
  }
  const validateSettlement = (count: number) =>
    Schema.decodeEffect(SettlementFrames)(count).pipe(
      Effect.mapError(() => measurementError('InvalidOptions')),
    )
  const measurement: Headless['measurement'] = Effect.uninterruptibleMask(() =>
    Effect.gen(function* () {
      if (options.session.running === false) return yield* measurementError('NotRunning')
      const parent = yield* Effect.scope
      const scope = yield* Scope.fork(parent)
      const initialReasons: IncompleteReason[] = []
      if (hasFrames === false || options.clock[frameSupport]() === false)
        initialReasons.push('NotConfigured')
      if (options.clock[visibility].isVisible() === false) initialReasons.push('Hidden')
      if (frames.calibration._tag !== 'Calibrated') initialReasons.push('CalibrationInvalid')
      const state = Ref.makeUnsafe<MeasurementState>({
        _tag: 'Open',
        before: {
          generation: options.session.generation,
          startedAtMs: options.clock.now(),
          captured: frames.captured,
          skipped: frames.skipped,
          invalid: frames.invalid,
          hidden: options.session.hidden,
          stopped: options.session.stopped,
          loss: loss(),
          counters: counters(),
          initialReasons,
        },
      })
      const control = { state, scope }
      yield* Scope.provide(
        Effect.acquireRelease(
          Effect.sync(() => live.add(control)),
          () =>
            Effect.gen(function* () {
              const previous = yield* Ref.modify(
                state,
                (current): [MeasurementState, MeasurementState] => [
                  current,
                  current._tag === 'Open' || current._tag === 'Frozen'
                    ? ({ _tag: 'Released' } as const)
                    : current._tag === 'Settling'
                      ? ({ _tag: 'Ended' } as const)
                      : current,
                ],
              )
              live.delete(control)
              if (previous._tag === 'Settling')
                yield* Deferred.fail(previous.wake, measurementError('ScopeClosed'))
            }),
        ),
        scope,
      )
      return {
        end: (endOptions = {}) =>
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const settleFrames = yield* validateSettlement(endOptions.settleFrames ?? 0)
              const wake = Deferred.makeUnsafe<MeasureResult, MeasureError>()
              const previous = yield* Ref.modify(
                state,
                (current): [MeasurementState, MeasurementState] => {
                  if (current._tag === 'Open')
                    return [current, { _tag: 'Settling', before: current.before, wake }]
                  if (current._tag === 'Frozen') return [current, { _tag: 'Ended' }]
                  return [current, current]
                },
              )
              if (previous._tag !== 'Open' && previous._tag !== 'Frozen')
                return yield* measurementError(
                  previous._tag === 'Released'
                    ? 'ScopeClosed'
                    : previous._tag === 'Invalidated'
                      ? 'StaleGeneration'
                      : 'AlreadyEnded',
                )
              const finish = Effect.gen(function* () {
                if (previous._tag === 'Frozen') return previous.result
                if (previous.before.generation !== options.session.generation)
                  return yield* measurementError('StaleGeneration')
                const settle = Effect.gen(function* () {
                  let settlementReason: 'Hidden' | 'Stopped' | undefined
                  if (settleFrames > 0 && options.clock[frameSupport]() === true)
                    yield* options.clock.waitFrames({ count: settleFrames }).pipe(
                      Effect.catchTag('ClockStopped', (error) =>
                        Effect.sync(() => {
                          settlementReason = error.reason
                        }),
                      ),
                    )
                  const current = yield* Ref.get(state)
                  if (current._tag !== 'Settling') return yield* Deferred.await(wake)
                  if (previous.before.generation !== options.session.generation)
                    return yield* measurementError('StaleGeneration')
                  return capture({
                    before: previous.before,
                    ...(settlementReason === undefined ? {} : { settlementReason }),
                  })
                })
                return yield* restore(Effect.raceFirst(settle, Deferred.await(wake)))
              })
              return yield* finish.pipe(
                Effect.ensuring(
                  Effect.gen(function* () {
                    yield* Ref.set(state, { _tag: 'Ended' })
                    live.delete(control)
                    yield* Scope.close(scope, Exit.succeed(undefined))
                  }),
                ),
              )
            }),
          ),
      } satisfies Measurement
    }),
  )
  const headless: Headless = {
    snapshot: () => {
      const totals = counters()
      const key = `${options.session.revision}:${options.store.getRevision()}:${frames.revision}`
      const previous = cached
      if (
        previous !== undefined &&
        key === cachedKey &&
        Object.keys(totals).length === Object.keys(previous.counters).length &&
        Object.entries(totals).every(
          ([id, value]) =>
            Object.hasOwn(previous.counters, id) === true && previous.counters[id] === value,
        ) === true
      )
        return previous
      const atMs = options.clock.now()
      cachedKey = key
      const frameSample: Sample<FrameStats> =
        hasFrames === false
          ? { _tag: 'Unavailable', atMs, reason: 'NotConfigured' }
          : options.session.running === false
            ? { _tag: 'Unavailable', atMs, reason: 'Stopped' }
            : options.clock[visibility].isVisible() === false
              ? { _tag: 'Unavailable', atMs, reason: 'Hidden' }
              : options.clock[frameSupport]() === false
                ? { _tag: 'Unavailable', atMs, reason: 'Unsupported' }
                : frames.summary(atMs)
      cached = Object.freeze({
        sessionId: options.sessionId,
        generation: options.session.generation,
        timeOriginMs: options.timeOriginMs,
        atMs,
        frames: frameSample,
        retention: Object.freeze(
          options.sources.map((source) => {
            const retained = source.retention()
            return Object.freeze({
              id: retained.id,
              range: Object.freeze({
                capacity: retained.range.capacity,
                length: retained.range.length,
                oldestAtMs: retained.range.oldestAtMs,
                newestAtMs: retained.range.newestAtMs,
                overflowCount: retained.range.overflowCount,
                firstRetainedSequence: retained.range.firstRetainedSequence,
                nextSequence: retained.range.nextSequence,
              }),
            })
          }),
        ),
        counters: totals,
      })
      return cached
    },
    snapshotSeries: options.store.snapshotSeries,
    measurement,
    measureWindow: ({ work, settleFrames = 30 }) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* validateSettlement(settleFrames)
          const resource = yield* measurement
          const result = yield* work
          const measured = yield* resource.end({ settleFrames })
          return { result, measurement: measured }
        }),
      ),
  }
  return {
    headless,
    stop: Effect.gen(function* () {
      for (const control of live) {
        const current = yield* Ref.get(control.state)
        if (current._tag === 'Open') {
          yield* Ref.set(control.state, {
            _tag: 'Frozen',
            result: capture({ before: current.before, settlementReason: 'Stopped' }),
          })
        } else if (current._tag === 'Settling') {
          const result = capture({ before: current.before, settlementReason: 'Stopped' })
          yield* Ref.set(control.state, { _tag: 'Ended' })
          live.delete(control)
          yield* Deferred.succeed(current.wake, result)
        }
      }
    }),
    restart: Effect.gen(function* () {
      const controls = Array.from(live)
      live.clear()
      yield* Effect.forEach(
        controls,
        (control) =>
          Effect.gen(function* () {
            const current = yield* Ref.get(control.state)
            yield* Ref.set(control.state, { _tag: 'Invalidated' })
            if (current._tag === 'Settling')
              yield* Deferred.fail(current.wake, measurementError('StaleGeneration'))
            yield* Scope.close(control.scope, Exit.succeed(undefined))
          }),
        { discard: true },
      )
    }),
  }
}

const measurementMessages: Readonly<Record<MeasureError['reason'], string>> = {
  NotRunning: 'Measurement acquisition requires a running session.',
  StaleGeneration: 'The measurement belongs to a previous collection generation.',
  AlreadyEnded: 'The measurement has already been claimed.',
  ScopeClosed: 'The owning measurement scope is closed.',
  InvalidOptions: 'settleFrames must be a nonnegative integer.',
}
const measurementError = (reason: MeasureError['reason']): MeasureError =>
  new MeasureError({ reason, message: measurementMessages[reason] })
