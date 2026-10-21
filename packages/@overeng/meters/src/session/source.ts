import { Effect, Scope } from 'effect'

import {
  validateId,
  type Cadence,
  type Retention,
  type Sample,
  type Series,
  type SeriesStore,
  type SeriesWriter,
  type UnavailableReason,
  type StatusValue,
} from '../series/index.ts'
import { notifyListeners } from '../series/internal.ts'
import type { FrameClock } from './clock.ts'
import { visibility } from './types.ts'

/** Freshness belongs to acquisition, never to a renderer or inert series. */
export type Freshness =
  | { readonly _tag: 'Window'; readonly ms: number }
  | { readonly _tag: 'While'; readonly status: Series<StatusValue>; readonly state: 'Connected' }
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
  readonly prepare: Effect.Effect<void, never, Scope.Scope>
  readonly acquire: Effect.Effect<void, SourceError, TEnv | Scope.Scope>
  readonly retention: () => { readonly id: string; readonly range: Retention }
  readonly evidence: SourceEvidence
  /** Direct append notification; payload remains in the authoritative store. */
  readonly observe: (listener: () => void) => () => void
  readonly onClockEvent: (event: {
    readonly _tag: 'Hidden' | 'Visible' | 'Stopped'
    readonly atMs: number
    readonly durationMs: number
  }) => void
}
/** A heterogeneous registration retains the source's environment requirements. */
export interface SourceRegistration<TEnv = never> {
  readonly id: string
  readonly series: { readonly id: string }
  readonly freshness?: Freshness
  readonly cadence: Cadence
  readonly evidence: SourceEvidence
  readonly [registration]: (options: {
    readonly store: SeriesStore
    readonly clock: FrameClock
    readonly isActive: () => boolean
    readonly observeStatus: (
      series: Series<StatusValue>,
      listener: (sample: Sample<StatusValue> | undefined) => void,
    ) => Effect.Effect<void, never, Scope.Scope>
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
  readonly freshness?: Freshness
}): Source<TValue, Exclude<TEnv, Scope.Scope>> => {
  validateId(options.id)
  if (
    options.cadence._tag === 'Interval' &&
    (Number.isFinite(options.cadence.everyMs) === false || options.cadence.everyMs <= 0)
  )
    throw new TypeError('Interval duration must be finite and positive')
  if (
    options.freshness?._tag === 'Window' &&
    (Number.isFinite(options.freshness.ms) === false || options.freshness.ms <= 0)
  )
    throw new TypeError('Freshness window must be finite and positive')
  const freshness =
    options.freshness === undefined ? undefined : Object.freeze({ ...options.freshness })
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
    ...(freshness === undefined ? {} : { freshness }),
    [registration]: ({
      store,
      clock,
      isActive,
      observeStatus,
    }: Parameters<SourceRegistration[typeof registration]>[0]): BoundSource<
      Exclude<TEnv, Scope.Scope>
    > => {
      const listeners = new Set<() => void>()
      let observed = false
      const writer = store.register({
        series,
        onAppend: () => {
          observed = true
          notifyListeners(listeners)
        },
      })
      let lifecycle: BoundSource['onClockEvent'] | undefined
      let lastKnown: { readonly atMs: number; readonly value: TValue } | undefined
      const append = (sample: Sample<TValue>): void => writer.append({ sample })
      let collect: Effect.Effect<void, SourceError, Exclude<TEnv, Scope.Scope> | Scope.Scope> =
        Effect.void
      const prepare = Effect.gen(function* () {
        let active = true
        observed = false
        yield* Effect.acquireRelease(Effect.void, () =>
          Effect.sync(() => {
            active = false
            lifecycle = undefined
          }),
        )
        if (freshness === undefined) {
          collect = start({
            sink: {
              append: ({ sample }) => {
                if (
                  active === true &&
                  isActive() === true &&
                  (cadence._tag !== 'Interval' || clock[visibility].isVisible() === true)
                )
                  append(sample)
              },
            },
            clock,
          })
          return
        }
        const scope = yield* Scope.Scope
        const context = yield* Effect.context<never>()
        const run = Effect.runForkWith(context)
        let connected = false
        let hidden = cadence._tag !== 'Event' && clock[visibility].isVisible() === false
        let failure: UnavailableReason | undefined
        let deadline: number | undefined
        let timing: number | undefined
        let nextWorker = 0
        const unavailable = ({
          reason,
          atMs = clock.now(),
        }: {
          readonly reason: UnavailableReason
          readonly atMs?: number
        }): void => {
          append({
            _tag: 'Unavailable',
            atMs,
            reason,
            ...(lastKnown === undefined ? {} : { lastKnown }),
          })
        }
        const expire = Effect.fn(function* (owner: number) {
          while (timing === owner && deadline !== undefined) {
            if (active === false) return
            const remaining = deadline - clock.now()
            if (remaining > 0) {
              yield* Effect.sleep(remaining)
              continue
            }
            deadline = undefined
            // Retire before publication: a reentrant observation owns its next deadline.
            timing = undefined
            if (isActive() === true && hidden === false) unavailable({ reason: 'Stale' })
          }
        })
        if (freshness._tag === 'Window') {
          const committed = (): void => {
            if (
              active === false ||
              isActive() === false ||
              deadline === undefined ||
              timing !== undefined
            )
              return
            const owner = ++nextWorker
            timing = owner
            try {
              run(
                Effect.forkIn(
                  expire(owner).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        // A retiring worker cannot clear a newer reentrant owner.
                        if (timing === owner) timing = undefined
                      }),
                    ),
                    Effect.withErrorReporting,
                  ),
                  scope,
                ),
              )
            } catch (cause) {
              if (timing === owner) timing = undefined
              throw cause
            }
          }
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              listeners.add(committed)
            }),
            () =>
              Effect.sync(() => {
                listeners.delete(committed)
              }),
          )
        }
        if (freshness._tag === 'While') {
          yield* observeStatus(freshness.status, (sample) => {
            if (active === false || isActive() === false) return
            const next = sample?._tag === 'Value' && sample.value.state === freshness.state
            if (next === connected) return
            connected = next
            if (hidden === false)
              unavailable({ reason: next === true ? (failure ?? 'Stale') : 'Disconnected' })
          })
          if (connected === false && hidden === false) unavailable({ reason: 'Disconnected' })
        }
        lifecycle = (event) => {
          if (event._tag === 'Stopped') {
            unavailable({ reason: 'Stopped', atMs: event.atMs })
            return
          }
          if (cadence._tag === 'Event') return
          hidden = event._tag === 'Hidden'
          if (hidden === true) unavailable({ reason: 'Hidden', atMs: event.atMs })
          else {
            const gap: Sample<TValue> = {
              _tag: 'Gap',
              atMs: event.atMs,
              durationMs: event.durationMs,
              reason: 'Hidden',
            }
            let faults: unknown[] | undefined
            try {
              append(gap)
            } catch (cause) {
              faults = [cause]
            }
            // Preserve any newer source or lifecycle evidence committed by a gap subscriber.
            if (store.read({ series }).latest === gap) {
              const reason =
                freshness._tag === 'While' && connected === false
                  ? 'Disconnected'
                  : failure === undefined ||
                      (freshness._tag === 'Window' &&
                        failure === 'MeasurementFailed' &&
                        (deadline === undefined || deadline <= clock.now()))
                    ? 'Stale'
                    : failure
              try {
                unavailable({ reason, atMs: event.atMs })
              } catch (cause) {
                ;(faults ??= []).push(cause)
              }
            }
            if (faults !== undefined)
              throw new AggregateError(faults, 'Source resume notification failed')
          }
        }
        const sink: SeriesWriter<TValue> = {
          append: ({ sample }) => {
            if (active === false || isActive() === false || hidden === true) return
            if (sample.atMs < (store.read({ series }).newestAtMs ?? 0)) return
            if (freshness._tag === 'While' && connected === false) return
            if (
              sample._tag === 'Unavailable' &&
              sample.reason !== 'Stale' &&
              sample.reason !== 'Disconnected'
            )
              failure = sample.reason
            else if (sample._tag === 'Value') failure = undefined
            if (sample._tag === 'Value') lastKnown = { atMs: sample.atMs, value: sample.value }
            const renews =
              sample._tag === 'Value' ||
              (sample._tag === 'Unavailable' && sample.reason === 'MeasurementFailed')
            if (freshness._tag === 'Window' && renews === true) {
              deadline = sample.atMs + freshness.ms
              if (deadline <= clock.now()) {
                deadline = undefined
                unavailable({ reason: 'Stale' })
                return
              }
            } else if (sample._tag === 'Unavailable') deadline = undefined
            append(
              sample._tag === 'Unavailable'
                ? {
                    _tag: 'Unavailable',
                    atMs: sample.atMs,
                    reason: sample.reason,
                    ...(lastKnown === undefined ? {} : { lastKnown }),
                  }
                : sample,
            )
          },
        }
        collect = start({ sink, clock })
      })
      return {
        prepare,
        acquire: Effect.suspend(() => collect),
        retention: () => ({ id: series.id, range: store.read({ series }) }),
        evidence,
        observe: (listener) => {
          listeners.add(listener)
          if (observed === true) listener()
          return () => {
            listeners.delete(listener)
          }
        },
        onClockEvent: (event) => {
          if (lifecycle !== undefined) {
            lifecycle(event)
            return
          }
          if (cadence._tag === 'Event') return
          if (event._tag === 'Visible')
            append({
              _tag: 'Gap',
              atMs: event.atMs,
              durationMs: event.durationMs,
              reason: 'Hidden',
            })
          else
            append({
              _tag: 'Unavailable',
              atMs: event.atMs,
              reason: event._tag === 'Hidden' ? 'Hidden' : 'Stopped',
            })
        },
      }
    },
  })
}
