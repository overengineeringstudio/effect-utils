import { Effect } from 'effect'

import type { NumberValue, Sample, Series } from '../series/index.ts'
import { makeSource, type Source } from './source.ts'
import { frameState, frameSupport } from './types.ts'

/** Refresh-rate eligibility is distinct from observed frame timing. */
export type Calibration =
  | { readonly _tag: 'Pending' }
  | { readonly _tag: 'Calibrated'; readonly bucket: 60 | 120 | 144 | 160 | 240 }
  | { readonly _tag: 'Unsupported'; readonly observedFps: number }
/** One captured visible frame with cumulative counts. */
export interface FpsValue {
  readonly _tag: 'Fps'
  readonly durationMs: number
  readonly skippedFrames: Sample<NumberValue>
  readonly framesCaptured: number
  readonly calibration: Calibration
}
/** Observed timing statistics over the actual two-second retained window. */
export interface FrameStats {
  readonly averageFps: number
  readonly p50Ms: number
  readonly p99Ms: number
  readonly framesCaptured: number
  readonly frameDrops: Sample<NumberValue>
  readonly calibration: Calibration
}
/** Session-owned bookkeeping; counter evidence survives retention and remounts. */
export class FrameState {
  captured = 0
  skipped = 0
  invalid = 0
  calibration: Calibration = { _tag: 'Pending' }
  previousAt: number | undefined
  previousIndex: number | undefined
  lastEvictedAt: number | undefined
  readonly durations: (number | undefined)[]
  readonly times: (number | undefined)[]
  readonly calibrationDurations: (number | undefined)[] = Array.from<number | undefined>({
    length: 500,
  })
  readonly scratch: number[] = []
  durationSequence = 0
  revision = 0
  cachedRevision = -1
  cached: Sample<FrameStats> = { _tag: 'Unavailable', atMs: 0, reason: 'NoSamples' }
  lastDuration = 0
  lastSkipped = 0
  readonly capacity: number
  constructor(capacity: number) {
    this.capacity = capacity
    this.durations = Array.from<number | undefined>({ length: capacity })
    this.times = Array.from<number | undefined>({ length: capacity })
  }
  rebase = (): void => {
    this.previousAt = undefined
    this.previousIndex = undefined
    this.revision++
  }
  tick = (atMs: number): void => {
    this.captured++
    this.revision++
    this.lastSkipped = 0
    const duration = this.previousAt === undefined ? undefined : atMs - this.previousAt
    this.previousAt = atMs
    if (duration !== undefined && duration > 0) {
      if (this.durationSequence >= this.capacity)
        this.lastEvictedAt = this.times[this.durationSequence % this.capacity]
      this.lastDuration = duration
      this.durations[this.durationSequence % this.capacity] = duration
      this.times[this.durationSequence % this.capacity] = atMs
      this.calibrationDurations[this.durationSequence % 500] = duration
      this.durationSequence++
    }
    const previousCalibration = this.calibration
    if (this.captured % 100 === 0 && this.durationSequence >= 10) {
      this.scratch.length = 0
      for (const entry of this.calibrationDurations)
        if (entry !== undefined) this.scratch.push(entry)
      this.scratch.sort((left, right) => left - right)
      const median = Math.floor(this.scratch.length / 2)
      let total = 0
      for (let index = median - 5; index < median + 5; index++) total += this.scratch[index] ?? 0
      const observedFps = Math.round(10000 / total)
      const buckets = [60, 120, 144, 160, 240] as const
      let nearest: (typeof buckets)[number] = 60
      for (const bucket of buckets)
        if (Math.abs(bucket - observedFps) < Math.abs(nearest - observedFps)) nearest = bucket
      this.calibration =
        Math.abs(nearest - observedFps) < 10
          ? { _tag: 'Calibrated', bucket: nearest }
          : { _tag: 'Unsupported', observedFps }
    }
    if (this.calibration._tag === 'Calibrated') {
      const index = Math.floor(atMs / (1000 / this.calibration.bucket))
      const sameBucket =
        previousCalibration._tag === 'Calibrated' &&
        previousCalibration.bucket === this.calibration.bucket
      if (sameBucket === true && this.previousIndex !== undefined)
        this.lastSkipped = Math.max(0, index - this.previousIndex - 1)
      this.previousIndex = index
      this.skipped += this.lastSkipped
    } else {
      this.previousIndex = undefined
      this.invalid++
    }
  }
  summary = (atMs: number): Sample<FrameStats> => {
    if (this.cachedRevision === this.revision) return this.cached
    this.cachedRevision = this.revision
    this.scratch.length = 0
    let total = 0
    const retained = Math.min(this.durationSequence, this.capacity)
    for (let index = this.durationSequence - retained; index < this.durationSequence; index++) {
      const time = this.times[index % this.capacity]
      const duration = this.durations[index % this.capacity]
      if (time !== undefined && duration !== undefined && time >= atMs - 2000) {
        this.scratch.push(duration)
        total += duration
      }
    }
    if (this.lastEvictedAt !== undefined && this.lastEvictedAt >= atMs - 2000)
      this.cached = { _tag: 'Unavailable', atMs, reason: 'HistoryLost' }
    else if (this.scratch.length === 0)
      this.cached = { _tag: 'Unavailable', atMs, reason: 'NoSamples' }
    else {
      this.scratch.sort((left, right) => left - right)
      this.cached = {
        _tag: 'Value',
        atMs,
        value: {
          averageFps: (1000 * this.scratch.length) / total,
          p50Ms: this.scratch[Math.ceil(this.scratch.length * 0.5) - 1] ?? 0,
          p99Ms: this.scratch[Math.ceil(this.scratch.length * 0.99) - 1] ?? 0,
          framesCaptured: this.captured,
          frameDrops:
            this.calibration._tag === 'Calibrated'
              ? { _tag: 'Value', atMs, value: { _tag: 'Number', value: this.skipped } }
              : { _tag: 'Unavailable', atMs, reason: 'CalibrationInvalid' },
          calibration: this.calibration,
        },
      }
    }
    if (this.cached._tag === 'Value') {
      const drops = this.cached.value.frameDrops
      if (drops._tag === 'Value') Object.freeze(drops.value)
      Object.freeze(drops)
      Object.freeze(this.cached.value.calibration)
      Object.freeze(this.cached.value)
    }
    Object.freeze(this.cached)
    return this.cached
  }
}
/** Select frame evidence using the session's single clock and bookkeeping. */
export const frameSource = (options: {
  readonly id: string
  readonly series: Series<FpsValue>
}): Source<FpsValue> =>
  makeSource({
    ...options,
    cadence: { _tag: 'PerFrame' },
    evidence: { frameCapacity: options.series.capacity },
    start: ({ sink, clock }) =>
      Effect.suspend(() => {
        if (clock[frameSupport]() === false)
          return Effect.sync(() => {
            sink.append({
              sample: { _tag: 'Unavailable', atMs: clock.now(), reason: 'Unsupported' },
            })
          })
        return clock
          .subscribe({
            phase: 'Source',
            listener: (tick) => {
              const state = clock[frameState]
              if (state.previousAt === undefined || tick.elapsedMs === 0) return
              if (state.lastSkipped > 0 && state.calibration._tag === 'Calibrated')
                sink.append({
                  sample: {
                    _tag: 'Gap',
                    atMs: tick.atMs,
                    durationMs: (state.lastSkipped * 1000) / state.calibration.bucket,
                    reason: 'MissedFrame',
                  },
                })
              sink.append({
                sample: {
                  _tag: 'Value',
                  atMs: tick.atMs,
                  value: {
                    _tag: 'Fps',
                    durationMs: tick.elapsedMs,
                    framesCaptured: state.captured,
                    calibration: state.calibration,
                    skippedFrames:
                      state.calibration._tag === 'Calibrated'
                        ? {
                            _tag: 'Value',
                            atMs: tick.atMs,
                            value: { _tag: 'Number', value: state.lastSkipped },
                          }
                        : { _tag: 'Unavailable', atMs: tick.atMs, reason: 'CalibrationInvalid' },
                  },
                },
              })
            },
          })
          .pipe(Effect.asVoid)
      }),
  })
