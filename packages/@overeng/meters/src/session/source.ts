import { Effect, Scope } from 'effect'

import {
  validateId,
  type Cadence,
  type Retention,
  type Series,
  type SeriesStore,
  type SeriesWriter,
} from '../series/index.ts'
import type { FrameClock } from './clock.ts'

/** Acquisition errors retain their source identity and original cause. */
export interface SourceError {
  readonly _tag: 'SourceError'
  readonly sourceId: string
  readonly reason: 'AcquisitionFailed' | 'InvalidConfiguration'
  readonly cause: Error
}
/** Private typed registration hook; never exposes an untyped writer. */
export const registration = Symbol('Source.registration')
/** Private instrument membership bound by the typed instrumentation registry. */
export const instrumentIdentities = Symbol('Source.instrumentIdentities')
/** Cumulative counters and independent loss markers bound by a source. */
export interface SourceEvidence {
  readonly frameCapacity?: number
  readonly counters?: () => Readonly<Record<string, number>>
  readonly loss?: () => number
  readonly [instrumentIdentities]?: readonly { readonly id: string; readonly identity: object }[]
}
/** Internal acquisition result preserving only typed closure capabilities. */
export interface BoundSource<TEnv = never> {
  readonly acquire: Effect.Effect<void, SourceError, TEnv | Scope.Scope>
  readonly retention: () => { readonly id: string; readonly range: Retention }
  readonly evidence: SourceEvidence
  readonly onClockEvent: (event: {
    readonly _tag: 'Hidden' | 'Visible' | 'Stopped'
    readonly atMs: number
    readonly durationMs: number
  }) => void
}
/** A heterogeneous registration retains the source's environment requirements. */
export interface SourceRegistration<TEnv = never> {
  readonly id: string
  readonly cadence: Cadence
  readonly evidence: SourceEvidence
  readonly [registration]: (options: {
    readonly store: SeriesStore
    readonly clock: FrameClock
    readonly isActive: () => boolean
  }) => BoundSource<TEnv>
}
/** A typed, inert source definition whose acquisition belongs to a caller scope. */
export interface Source<TValue, TEnv = never> extends SourceRegistration<TEnv> {
  readonly series: Series<TValue>
  readonly start: (options: {
    readonly sink: SeriesWriter<TValue>
    readonly clock: FrameClock
  }) => Effect.Effect<void, SourceError, TEnv | Scope.Scope>
}
/** Capture a typed registration closure without erasing a payload through casts. */
export const makeSource = <TValue, TEnv = never>(options: {
  readonly id: string
  readonly cadence: Cadence
  readonly series: Series<TValue>
  readonly start: Source<TValue, TEnv>['start']
  readonly evidence?: SourceEvidence
}): Source<TValue, Exclude<TEnv, Scope.Scope>> => {
  validateId(options.id)
  if (
    options.cadence._tag === 'Interval' &&
    (Number.isFinite(options.cadence.everyMs) === false || options.cadence.everyMs <= 0)
  )
    throw new TypeError('Interval duration must be finite and positive')
  const cadence = Object.freeze({ ...options.cadence })
  const acquireSource = options.start
  const start: Source<TValue, Exclude<TEnv, Scope.Scope>>['start'] = ({ sink, clock }) =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      yield* Scope.provide(acquireSource({ sink, clock }), scope)
    })
  const series = options.series
  const evidence = Object.freeze({ ...options.evidence })
  return Object.freeze({
    id: options.id,
    cadence,
    series,
    start,
    evidence,
    [registration]: ({
      store,
      clock,
      isActive,
    }: {
      readonly store: SeriesStore
      readonly clock: FrameClock
      readonly isActive: () => boolean
    }): BoundSource<Exclude<TEnv, Scope.Scope>> => {
      const writer = store.register({ series })
      const acquire = Effect.gen(function* () {
        let active = true
        yield* Effect.acquireRelease(Effect.void, () =>
          Effect.sync(() => {
            active = false
          }),
        )
        const sink: SeriesWriter<TValue> = {
          append: ({ sample }) => {
            if (active === true && isActive() === true) writer.append({ sample })
          },
        }
        yield* start({ sink, clock })
      })
      return {
        acquire,
        retention: () => ({ id: series.id, range: store.read({ series }) }),
        evidence,
        onClockEvent: (event: {
          readonly _tag: 'Hidden' | 'Visible' | 'Stopped'
          readonly atMs: number
          readonly durationMs: number
        }) => {
          if (cadence._tag === 'Event') return
          if (event._tag === 'Visible')
            writer.append({
              sample: {
                _tag: 'Gap',
                atMs: event.atMs,
                durationMs: event.durationMs,
                reason: 'Hidden',
              },
            })
          else
            writer.append({
              sample: {
                _tag: 'Unavailable',
                atMs: event.atMs,
                reason: event._tag === 'Hidden' ? 'Hidden' : 'Stopped',
              },
            })
        },
      }
    },
  })
}
