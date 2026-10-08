import { Effect, Scope } from 'effect'

import { FrameState } from './frame.ts'
import { frameState, frameSupport, visibility } from './types.ts'

/** A single visible frame opportunity delivered to all phases. */
export interface FrameTick {
  readonly atMs: number
  readonly elapsedMs: number
  readonly sequence: number
}
/** Settlement terminates rather than waiting for hidden or stopped frames. */
export interface ClockStopped {
  readonly _tag: 'ClockStopped'
  readonly reason: 'Stopped' | 'Hidden'
}
/** Browser capabilities supplied by the host; core never reads browser globals. */
export interface Platform {
  readonly now: () => number
  readonly timeOriginMs: number
  readonly requestFrame: (callback: (atMs: number) => void) => number
  readonly cancelFrame: (id: number) => void
  readonly isVisible: () => boolean
  readonly observeVisibility: (listener: (visible: boolean) => void) => () => void
  readonly supportsFrames?: () => boolean
}
/** One session clock; subscriptions are scoped and collection-independent. */
export interface FrameClock {
  readonly subscribe: (options: {
    readonly listener: (tick: FrameTick) => void
    readonly phase: 'Source' | 'Draw'
  }) => Effect.Effect<void, never, Scope.Scope>
  readonly waitFrames: (options: { readonly count: number }) => Effect.Effect<void, ClockStopped>
  readonly now: () => number
  readonly [frameState]: FrameState
  readonly [frameSupport]: () => boolean
  readonly [visibility]: {
    readonly isVisible: () => boolean
    readonly waitVisible: Effect.Effect<void, ClockStopped>
  }
}
const rethrowFault = (cause: unknown): never => {
  throw cause
}
const noop = (): void => {}

/** Internal lifecycle control for a clock with no construction-time platform reads. */
export const makeFrameClock = (options: {
  readonly platform: Platform
  readonly capacity: number
  readonly changed: (event: {
    readonly _tag: 'Hidden' | 'Visible' | 'Stopped'
    readonly atMs: number
    readonly durationMs: number
  }) => void
}) => {
  const state = new FrameState(options.capacity)
  const sources = new Set<(tick: FrameTick) => void>()
  const draws = new Set<(tick: FrameTick) => void>()
  const waiters = new Set<{
    remaining: number
    readonly resume: (effect: Effect.Effect<void, ClockStopped>) => void
  }>()
  const visibleWaiters = new Set<(effect: Effect.Effect<void, ClockStopped>) => void>()
  let running = false
  let visible = false
  let supportsFrames = true
  let pending: number | undefined
  let callbackGeneration = 0
  let previous: number | undefined
  let summaryAt: number | undefined
  let hiddenAt: number | undefined
  let report: (cause: unknown) => void = rethrowFault
  const failWaiters = (reason: ClockStopped['reason']): void => {
    for (const waiter of waiters) waiter.resume(Effect.fail({ _tag: 'ClockStopped', reason }))
    waiters.clear()
  }
  const cancel = (): void => {
    callbackGeneration++
    if (pending !== undefined) {
      options.platform.cancelFrame(pending)
      pending = undefined
    }
    previous = undefined
    summaryAt = undefined
    state.rebase()
  }
  const request = (): void => {
    if (
      running === false ||
      visible === false ||
      supportsFrames === false ||
      pending !== undefined ||
      sources.size + draws.size + waiters.size === 0
    )
      return
    const generation = callbackGeneration
    pending = options.platform.requestFrame((atMs) => {
      if (generation !== callbackGeneration) return
      pending = undefined
      if (running === false || visible === false) return
      const tick: FrameTick = {
        atMs,
        elapsedMs: previous === undefined ? 0 : Math.max(0, atMs - previous),
        sequence: state.captured + 1,
      }
      previous = atMs
      state.tick(atMs)
      if (summaryAt === undefined) summaryAt = atMs
      if (atMs - summaryAt >= 250) {
        state.summary(atMs)
        summaryAt = atMs
      }
      for (const listener of sources) {
        try {
          listener(tick)
        } catch (cause) {
          report(cause)
        }
      }
      for (const listener of draws) {
        try {
          listener(tick)
        } catch (cause) {
          report(cause)
        }
      }
      for (const waiter of waiters) {
        waiter.remaining--
        if (waiter.remaining === 0) {
          waiters.delete(waiter)
          waiter.resume(Effect.void)
        }
      }
      request()
    })
  }
  const clock: FrameClock = {
    now: options.platform.now,
    [frameState]: state,
    [frameSupport]: () => supportsFrames,
    [visibility]: {
      isVisible: () => running === true && visible === true,
      waitVisible: Effect.callback<void, ClockStopped>((resume) => {
        if (running === false) {
          resume(Effect.fail({ _tag: 'ClockStopped', reason: 'Stopped' }))
          return
        }
        if (visible === true) {
          resume(Effect.void)
          return
        }
        visibleWaiters.add(resume)
        return Effect.sync(() => {
          visibleWaiters.delete(resume)
        })
      }),
    },
    subscribe: ({ listener, phase }) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const listeners = phase === 'Source' ? sources : draws
          listeners.add(listener)
          request()
          return listeners
        }),
        (listeners) =>
          Effect.sync(() => {
            listeners.delete(listener)
            if (sources.size + draws.size + waiters.size === 0) cancel()
          }),
      ).pipe(Effect.asVoid),
    waitFrames: ({ count }) =>
      Effect.callback<void, ClockStopped>((resume) => {
        if (Number.isInteger(count) === false || count < 0) {
          resume(Effect.die(new TypeError('Frame count must be a nonnegative integer')))
          return
        }
        if (running === false || visible === false) {
          resume(
            Effect.fail({ _tag: 'ClockStopped', reason: running === false ? 'Stopped' : 'Hidden' }),
          )
          return
        }
        if (count === 0) {
          resume(Effect.void)
          return
        }
        if (supportsFrames === false) {
          resume(Effect.fail({ _tag: 'ClockStopped', reason: 'Stopped' }))
          return
        }
        const waiter = { remaining: count, resume }
        waiters.add(waiter)
        request()
        return Effect.sync(() => {
          waiters.delete(waiter)
          if (sources.size + draws.size + waiters.size === 0) cancel()
        })
      }),
  }
  return {
    clock,
    activate: (onFault: (cause: unknown) => void): (() => void) => {
      let active = true
      let stopVisibility = noop
      const deactivate = (): void => {
        active = false
        running = false
        cancel()
        failWaiters('Stopped')
        for (const resume of visibleWaiters)
          resume(Effect.fail({ _tag: 'ClockStopped', reason: 'Stopped' }))
        visibleWaiters.clear()
        try {
          stopVisibility()
        } finally {
          options.changed({ _tag: 'Stopped', atMs: clock.now(), durationMs: 0 })
        }
      }
      try {
        report = onFault
        running = true
        visible = options.platform.isVisible()
        supportsFrames = options.platform.supportsFrames?.() ?? true
        previous = undefined
        state.rebase()
        if (visible === false) {
          hiddenAt = clock.now()
          options.changed({ _tag: 'Hidden', atMs: hiddenAt, durationMs: 0 })
        }
        stopVisibility = options.platform.observeVisibility((next) => {
          if (active === false || running === false || visible === next) return
          visible = next
          const atMs = clock.now()
          if (next === false) {
            hiddenAt = atMs
            cancel()
            failWaiters('Hidden')
            options.changed({ _tag: 'Hidden', atMs, durationMs: 0 })
          } else {
            const durationMs = hiddenAt === undefined ? 0 : atMs - hiddenAt
            hiddenAt = undefined
            cancel()
            options.changed({ _tag: 'Visible', atMs, durationMs })
            for (const resume of visibleWaiters) resume(Effect.void)
            visibleWaiters.clear()
            request()
          }
        })
        request()
        return deactivate
      } catch (cause) {
        deactivate()
        throw cause
      }
    },
  }
}
/** Install a single-flight interval loop, paused while hidden and interrupted with its scope. */
export const runInterval = <TError, TEnv>(options: {
  readonly clock: FrameClock
  readonly everyMs: number
  readonly observe: Effect.Effect<void, TError, TEnv>
}): Effect.Effect<void, never, TEnv | Scope.Scope> =>
  Effect.gen(function* () {
    if (Number.isFinite(options.everyMs) === false || options.everyMs <= 0)
      return yield* Effect.die(new TypeError('Interval duration must be finite and positive'))
    const scope = yield* Scope.Scope
    const loop = Effect.gen(function* () {
      yield* options.clock[visibility].waitVisible
      if (options.clock[visibility].isVisible() === true) yield* options.observe
      yield* Effect.sleep(options.everyMs)
    }).pipe(Effect.forever)
    yield* Effect.forkIn(loop, scope)
  })
