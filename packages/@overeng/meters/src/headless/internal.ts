import { Effect, Exit } from 'effect'

import type {
  NumberValue,
  Retention,
  Sample,
  Series,
  SeriesSnapshot,
  SeriesStore,
} from '../series/index.ts'
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
/** Serializable identity checked field-for-field against the session registry. */
export interface MeasureHandle {
  readonly _tag: 'MeasureHandle'
  readonly sessionId: string
  readonly generation: number
  readonly id: number
  readonly startedAtMs: number
}
/** Eligible bracket-scoped cumulative deltas, not trailing statistics. */
export interface CompleteData {
  readonly durationMs: number
  readonly framesCaptured: number
  readonly frameDrops: number
  readonly averageFps: number
  readonly counterDelta: Readonly<Record<string, number>>
}
/** Truthful partial evidence for an ineligible measurement. */
export interface PartialData {
  readonly durationMs: number
  readonly framesCaptured: number
  readonly frameDrops: Sample<NumberValue>
  readonly averageFps: Sample<NumberValue>
  readonly counterDelta: Readonly<Record<string, number>>
}
/** Reasons retained across resume, recovery, and ring eviction. */
export type IncompleteReason =
  | 'Hidden'
  | 'CalibrationInvalid'
  | 'Stopped'
  | 'NoSamples'
  | 'NotConfigured'
  | 'HistoryLost'
  | 'ObservationLost'
/** Only Complete measurements are eligible for performance gates. */
export type MeasureResult =
  | { readonly _tag: 'Complete'; readonly eligible: true; readonly data: CompleteData }
  | {
      readonly _tag: 'Incomplete'
      readonly eligible: false
      readonly reasons: readonly [IncompleteReason, ...IncompleteReason[]]
      readonly data: PartialData
    }
/** Explicit identity, lifecycle, or settlement validation failure. */
export interface MeasureError {
  readonly _tag: 'MeasureError'
  readonly reason:
    | 'NotRunning'
    | 'WrongSession'
    | 'StaleGeneration'
    | 'AlreadyEnded'
    | 'InvalidHandle'
    | 'InvalidOptions'
}
/** Independent snapshots and scoped split/work brackets. */
export interface Headless {
  readonly snapshot: () => Snapshot
  readonly snapshotSeries: <TValue>(options: {
    readonly series: Series<TValue>
  }) => SeriesSnapshot<TValue>
  readonly beginMeasure: Effect.Effect<MeasureHandle, MeasureError>
  readonly endMeasure: (options: {
    readonly handle: MeasureHandle
    readonly settleFrames?: number
  }) => Effect.Effect<MeasureResult, MeasureError>
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
  readonly handle: MeasureHandle
  readonly captured: number
  readonly skipped: number
  readonly invalid: number
  readonly hidden: number
  readonly stopped: number
  readonly loss: number
  readonly counters: Readonly<Record<string, number>>
  readonly initialReasons: readonly IncompleteReason[]
}
const validSettlement = (count: number): boolean => Number.isInteger(count) === true && count >= 0

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
}): Headless => {
  const active = new Map<number, Before>()
  const ended = new Map<number, MeasureHandle>()
  let nextId = 0
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
  const beginMeasure = Effect.sync(() => options.session.running).pipe(
    Effect.filterOrFail(
      (running) => running === true,
      (): MeasureError => ({ _tag: 'MeasureError', reason: 'NotRunning' }),
    ),
    Effect.map(() => {
      const handle: MeasureHandle = Object.freeze({
        _tag: 'MeasureHandle',
        sessionId: options.sessionId,
        generation: options.session.generation,
        id: ++nextId,
        startedAtMs: options.clock.now(),
      })
      const initialReasons: IncompleteReason[] = []
      if (hasFrames === false || options.clock[frameSupport]() === false)
        initialReasons.push('NotConfigured')
      if (options.clock[visibility].isVisible() === false) initialReasons.push('Hidden')
      if (frames.calibration._tag !== 'Calibrated') initialReasons.push('CalibrationInvalid')
      active.set(handle.id, {
        handle,
        captured: frames.captured,
        skipped: frames.skipped,
        invalid: frames.invalid,
        hidden: options.session.hidden,
        stopped: options.session.stopped,
        loss: loss(),
        counters: counters(),
        initialReasons,
      })
      return handle
    }),
  )
  const endMeasure: Headless['endMeasure'] = Effect.fnUntraced(function* ({
    handle,
    settleFrames = 0,
  }) {
    if (validSettlement(settleFrames) === false)
      return yield* Effect.fail<MeasureError>({ _tag: 'MeasureError', reason: 'InvalidOptions' })
    if (handle._tag !== 'MeasureHandle' || Number.isInteger(handle.id) === false)
      return yield* Effect.fail<MeasureError>({ _tag: 'MeasureError', reason: 'InvalidHandle' })
    if (handle.sessionId !== options.sessionId)
      return yield* Effect.fail<MeasureError>({ _tag: 'MeasureError', reason: 'WrongSession' })
    if (handle.generation !== options.session.generation)
      return yield* Effect.fail<MeasureError>({ _tag: 'MeasureError', reason: 'StaleGeneration' })
    const before = active.get(handle.id)
    const expected = before?.handle ?? ended.get(handle.id)
    if (
      expected === undefined ||
      expected.startedAtMs !== handle.startedAtMs ||
      expected.generation !== handle.generation ||
      Object.keys(handle).length !== 5 ||
      ['_tag', 'sessionId', 'generation', 'id', 'startedAtMs'].every((key) =>
        Object.hasOwn(handle, key),
      ) === false
    )
      return yield* Effect.fail<MeasureError>({ _tag: 'MeasureError', reason: 'InvalidHandle' })
    if (before === undefined)
      return yield* Effect.fail<MeasureError>({ _tag: 'MeasureError', reason: 'AlreadyEnded' })
    active.delete(handle.id)
    ended.set(handle.id, before.handle)
    const reasons = new Set<IncompleteReason>(before.initialReasons)
    if (settleFrames > 0 && options.clock[frameSupport]() === true) {
      yield* options.clock.waitFrames({ count: settleFrames }).pipe(
        Effect.catchTag('ClockStopped', (stopped) =>
          Effect.sync(() => {
            reasons.add(stopped.reason)
          }),
        ),
      )
    }
    if (options.clock[frameSupport]() === false) reasons.add('NotConfigured')
    const atMs = options.clock.now()
    const durationMs = atMs - before.handle.startedAtMs
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
  })
  return {
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
    beginMeasure,
    endMeasure,
    measureWindow: ({ work, settleFrames = 30 }) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (validSettlement(settleFrames) === false)
            return yield* Effect.fail<MeasureError>({
              _tag: 'MeasureError',
              reason: 'InvalidOptions',
            })
          const handle = yield* beginMeasure
          const workExit = yield* Effect.exit(restore(work))
          if (Exit.isFailure(workExit) === true) {
            yield* endMeasure({ handle }).pipe(Effect.ignoreCause)
            return yield* Effect.failCause(workExit.cause)
          }
          const measurement = yield* restore(endMeasure({ handle, settleFrames })).pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit) === true
                ? endMeasure({ handle }).pipe(Effect.ignoreCause, Effect.asVoid)
                : Effect.void,
            ),
          )
          return { result: workExit.value, measurement }
        }),
      ),
  }
}
