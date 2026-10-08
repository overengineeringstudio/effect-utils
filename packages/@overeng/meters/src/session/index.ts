import { Effect, Exit, Scope, Semaphore } from 'effect'

import { makeHeadless, type Headless, type SessionEvidence } from '../headless/internal.ts'
import { makeSeriesStore, type SeriesStore } from '../series/index.ts'
import { publishRevision } from '../series/internal.ts'
import { makeFrameClock, type FrameClock, type Platform } from './clock.ts'
import {
  instrumentIdentities,
  registration,
  type BoundSource,
  type SourceError,
  type SourceRegistration,
} from './source.ts'
import { visibility } from './types.ts'

export type { FrameClock, FrameTick, ClockStopped, Platform } from './clock.ts'
export { runInterval } from './clock.ts'
export type { Source, SourceRegistration, SourceError, SourceEvidence } from './source.ts'
export { makeSource } from './source.ts'
export type { Calibration, FpsValue, FrameStats } from './frame.ts'
export { frameSource } from './frame.ts'

/** Inert session definition; start acquires a shared lease in the caller's scope. */
export interface Meters<TEnv = never> {
  readonly store: SeriesStore
  readonly clock: FrameClock
  readonly headless: Headless
  readonly start: Effect.Effect<void, SourceError, TEnv | Scope.Scope>
}
const rethrowFault = (cause: unknown): never => {
  throw cause
}

let nextSessionId = 0
/** Construct a session without reading capabilities, installing collectors, or creating a runtime. */
export const makeMeters = <TEnv = never>(options: {
  readonly sources: readonly SourceRegistration<TEnv>[]
  readonly platform: Platform
}): Meters<TEnv> => {
  const ids = new Set<string>()
  for (const source of options.sources) {
    if (ids.has(source.id) === true) throw new TypeError(`Duplicate source: ${source.id}`)
    ids.add(source.id)
  }
  const store = makeSeriesStore()
  const session: SessionEvidence = {
    running: false,
    generation: 0,
    revision: 0,
    hidden: 0,
    stopped: 0,
  }
  const gate = Semaphore.makeUnsafe(1)
  let leases = 0
  let collectorScope: Scope.Closeable | undefined
  let deactivate: (() => void) | undefined
  let acquisitionActive = false
  let reportFault: (cause: unknown) => void = rethrowFault
  const registrations: BoundSource<TEnv>[] = []
  const controller = makeFrameClock({
    platform: options.platform,
    capacity: Math.max(1, ...options.sources.map((source) => source.evidence.frameCapacity ?? 1)),
    changed: (event) => {
      session.revision++
      if (event._tag === 'Hidden') session.hidden++
      if (event._tag === 'Stopped') session.stopped++
      for (const source of registrations) {
        try {
          source.onClockEvent(event)
        } catch (cause) {
          reportFault(cause)
        }
      }
      try {
        store[publishRevision]()
      } catch (cause) {
        reportFault(cause)
      }
    },
  })
  for (const source of options.sources)
    registrations.push(
      source[registration]({
        store,
        clock: controller.clock,
        isActive: () =>
          acquisitionActive === true &&
          (source.cadence._tag !== 'Interval' || controller.clock[visibility].isVisible() === true),
      }),
    )
  const seriesIds = new Set<string>()
  for (const source of registrations) {
    const id = source.retention().id
    if (seriesIds.has(id) === true) throw new TypeError(`Duplicate series: ${id}`)
    seriesIds.add(id)
  }
  const instruments = new Map<string, object>()
  for (const source of registrations)
    for (const instrument of source.evidence[instrumentIdentities] ?? []) {
      const previous = instruments.get(instrument.id)
      if (previous !== undefined && previous !== instrument.identity)
        throw new TypeError(`Duplicate instrument: ${instrument.id}`)
      instruments.set(instrument.id, instrument.identity)
    }
  const headless = makeHeadless({
    sessionId: `meters-${++nextSessionId}`,
    timeOriginMs: options.platform.timeOriginMs,
    clock: controller.clock,
    store,
    session,
    sources: registrations,
  })
  const acquire = Effect.gen(function* () {
    if (leases > 0) {
      leases++
      return
    }
    const scope = yield* Scope.make()
    const context = yield* Effect.context<TEnv>()
    collectorScope = scope
    acquisitionActive = true
    session.generation++
    session.revision++
    const run = Effect.runForkWith(context)
    reportFault = (cause) => {
      run(Effect.die(cause))
    }
    const acquired = yield* Effect.exit(
      Effect.gen(function* () {
        deactivate = yield* Effect.sync(() => controller.activate(reportFault))
        yield* Effect.forEach(registrations, (source) => Scope.provide(source.acquire, scope), {
          discard: true,
        })
      }),
    )
    if (Exit.isFailure(acquired) === true) {
      acquisitionActive = false
      session.running = false
      deactivate?.()
      deactivate = undefined
      yield* Scope.close(scope, acquired)
      collectorScope = undefined
      return yield* Effect.failCause(acquired.cause)
    }
    session.running = true
    session.revision++
    yield* Effect.try({
      try: () => store[publishRevision](),
      catch: (cause): SourceError => ({
        _tag: 'SourceError',
        sourceId: 'session.publication',
        reason: 'AcquisitionFailed',
        cause: cause instanceof Error ? cause : new Error('Session subscriber failed', { cause }),
      }),
    }).pipe(Effect.catch((error) => Effect.sync(() => reportFault(error.cause))))
    leases = 1
  }).pipe(Semaphore.withPermits(gate, 1))
  const release = Effect.gen(function* () {
    leases--
    if (leases !== 0) return
    acquisitionActive = false
    session.running = false
    deactivate?.()
    deactivate = undefined
    const scope = collectorScope
    collectorScope = undefined
    if (scope !== undefined) yield* Scope.close(scope, Exit.succeed(undefined))
  }).pipe(Semaphore.withPermits(gate, 1))
  return {
    store,
    clock: controller.clock,
    headless,
    start: Effect.acquireRelease(acquire, () => release).pipe(Effect.asVoid),
  }
}
