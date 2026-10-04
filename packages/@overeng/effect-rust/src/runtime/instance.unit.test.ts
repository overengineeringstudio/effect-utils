import { describe, expect, it } from '@effect/vitest'
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Scheduler,
  Scope,
  Stream,
} from 'effect'

import {
  chunkProfiles,
  makeRuntime,
  type Instance,
  type PanicObserver,
  type RustJob,
  type Runtime,
} from './instance.ts'
import { isolateRuntime, wasmLayer } from './interop.ts'

// Real wasm trap and identity exports, without a Rust toolchain or cached bindgen glue.
const module = new WebAssembly.Module(
  new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 9, 2, 96, 0, 0, 96, 1, 127, 1, 127, 3, 3, 2, 0, 1, 7, 16, 2, 4,
    116, 114, 97, 112, 0, 0, 5, 118, 97, 108, 117, 101, 0, 1, 10, 10, 2, 3, 0, 0, 11, 4, 0, 32, 0,
    11,
  ]),
)
interface FakeApi {
  readonly value: (input: number) => number
  readonly trap: () => void
  readonly trapOnPoll: (gate?: Promise<void>) => Promise<never>
  readonly pending: () => Promise<never>
}
const fake = () => {
  let loads = 0
  let releases = 0
  let live = 0
  const observers: PanicObserver[] = []
  const load = (): Instance<FakeApi> => {
    loads++
    const instance = new WebAssembly.Instance(module)
    const value = instance.exports.value
    const trap = instance.exports.trap
    if (typeof value !== 'function' || typeof trap !== 'function')
      throw new Error('Invalid test wasm exports')
    const pending = new Set<(cause: unknown) => void>()
    let observer: PanicObserver | undefined
    let scheduled = 0
    return {
      api: {
        value: (input) => Number(value(input)),
        trap: () => {
          trap()
        },
        trapOnPoll: (gate = Promise.resolve()) => {
          scheduled++
          live++
          void gate.then(() => {
            try {
              trap()
            } catch (cause) {
              if (cause instanceof WebAssembly.RuntimeError && observer !== undefined)
                observer(cause)
              else throw cause
            }
          })
          // Like future_to_promise, a poll trap never settles this result.
          return new Promise<never>(() => undefined)
        },
        pending: () =>
          new Promise<never>((_, reject) => {
            pending.add(reject)
            live++
          }),
      },
      observePanic: (onPanic) => {
        observer = onPanic
        observers.push(onPanic)
        return () => {
          observer = undefined
        }
      },
      release: () => {
        releases++
        live -= pending.size + scheduled
        for (const reject of pending) reject(new Error('Instance released'))
        pending.clear()
      },
    }
  }
  return { load, observers, counts: () => ({ loads, releases, live }) }
}

const assertDefect = <T, TError>(exit: Exit.Exit<T, TError>) => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit) === true) expect(Cause.hasDies(exit.cause)).toBe(true)
}

// Match the shutdown sweep below: force only the chosen shouldYield check, and
// withhold its dispatcher task until the competing Effect has been scheduled.
const makeBoundaryScheduler = (yieldAt: number) => {
  const paused = Promise.withResolvers<boolean>()
  const defaultScheduler = new Scheduler.MixedScheduler()
  let checks = 0
  let forcedYields = 0
  let sampling = true
  let pauseRequested = false
  let resumeTask: (() => void) | undefined
  const scheduler: Scheduler.Scheduler = {
    executionMode: 'async',
    shouldYield: () => {
      if (sampling === false) return false
      if (++checks !== yieldAt) return false
      forcedYields++
      pauseRequested = true
      return true
    },
    makeDispatcher: () => {
      const dispatcher = defaultScheduler.makeDispatcher()
      return {
        scheduleTask: (task, priority) => {
          if (pauseRequested === true) {
            resumeTask = () => {
              pauseRequested = false
              dispatcher.scheduleTask(task, priority)
            }
            paused.resolve(true)
          } else dispatcher.scheduleTask(task, priority)
        },
        flush: () => dispatcher.flush(),
      }
    },
  }
  return {
    scheduler,
    paused: paused.promise,
    resume: () => resumeTask!(),
    stop: () => {
      // Finalizers retain their acquisition Scheduler service. Teardown is not
      // part of this operation's sample and must never withhold another task.
      sampling = false
    },
    counts: () => ({ checks, forcedYields }),
  }
}

describe('instance generations', () => {
  it('executes synchronous exports with runSync after asynchronous runtime acquisition', async () => {
    const fixture = fake()
    class Core extends Context.Service<Core, Runtime<FakeApi>>()('test/sync-Core') {}
    const managed = isolateRuntime(
      wasmLayer.node(Core, { load: fixture.load, make: (runtime) => runtime }),
    )
    try {
      const runtime = await managed.runPromise(Core)
      expect(Effect.runSync(runtime.callSync((api) => api.value(42)))).toBe(42)
      expect(Effect.runSync(runtime.snapshot)).toMatchObject({ jobs: 0, state: 'healthy' })
      // eslint-disable-next-line unicorn/no-thenable -- This non-callable then property proves ordinary data is not treated as PromiseLike.
      const value = { then: 'ordinary data' }
      expect(Effect.runSync(runtime.callSync(() => value))).toBe(value)
      expect(Effect.runSync(runtime.callSync(() => undefined))).toBeUndefined()
    } finally {
      await managed.dispose()
    }
    expect(fixture.counts()).toEqual({ loads: 1, releases: 1, live: 0 })
  })

  it.effect('traps kill every pending Effect, retire glue, and rebuild before the next call', () =>
    Effect.gen(function* () {
      const fixture = fake()
      class Core extends Context.Service<Core, Runtime<FakeApi>>()('test/Core') {}
      const context = yield* Layer.build(
        wasmLayer.node(Core, { load: fixture.load, make: (runtime) => runtime }),
      )
      const runtime = Context.get(context, Core)
      const waiting = yield* runtime
        .call(({ api }) => api.pending())
        .pipe(Effect.forkChild({ startImmediately: true }))
      expect((yield* runtime.snapshot).jobs).toBe(1)
      assertDefect(yield* Effect.exit(runtime.callSync((api) => api.trap())))
      assertDefect(yield* Fiber.await(waiting))
      expect(yield* runtime.callSync((api) => api.value(42))).toBe(42)
      expect(fixture.counts()).toEqual({ loads: 2, releases: 1, live: 0 })
      expect(yield* runtime.snapshot).toMatchObject({
        generation: 2,
        jobs: 0,
        handles: 0,
        state: 'healthy',
      })
    }),
  )
  for (const poll of ['first', 'after-host-await'] as const) {
    it.effect(
      `${poll} scheduler traps defect orphaned calls and siblings without leaking generations`,
      () =>
        Effect.gen(function* () {
          const fixture = fake()
          const runtime = yield* makeRuntime('test/scheduler', { load: fixture.load })
          const gate = Promise.withResolvers<void>()
          const waiting = yield* runtime
            .call(({ api }) => api.pending())
            .pipe(Effect.forkChild({ startImmediately: true }))
          const panic = yield* runtime
            .call(({ api }) => api.trapOnPoll(poll === 'first' ? undefined : gate.promise))
            .pipe(Effect.forkChild({ startImmediately: true }))
          if (poll === 'after-host-await') {
            expect(yield* runtime.snapshot).toMatchObject({
              generation: 1,
              jobs: 2,
              state: 'healthy',
            })
            gate.resolve()
          }
          assertDefect(yield* Fiber.await(panic))
          assertDefect(yield* Fiber.await(waiting))
          expect(yield* runtime.call(({ api }) => api.value(42))).toBe(42)
          expect(fixture.counts()).toEqual({ loads: 2, releases: 1, live: 0 })
          // Even a callback captured before unsubscription belongs to the old generation.
          fixture.observers[0]!(new WebAssembly.RuntimeError('late old-generation trap'))
          expect(yield* runtime.call(({ api }) => api.value(17))).toBe(17)
          expect(yield* runtime.snapshot).toMatchObject({
            generation: 2,
            jobs: 0,
            state: 'healthy',
          })
        }),
    )
  }

  for (const mode of ['abortable', 'settle-only'] as const) {
    it.effect(
      `${mode} interruption does not wait forever for promises orphaned by a scheduler trap`,
      () =>
        Effect.gen(function* () {
          const fixture = fake()
          const runtime = yield* makeRuntime('test/scheduler-cancel', { load: fixture.load })
          const gate = Promise.withResolvers<void>()
          const cancelStarted = yield* Deferred.make<void>()
          const waiting = yield* runtime
            .call(({ api }): RustJob<never> => {
              const result = api.trapOnPoll(gate.promise)
              return mode === 'settle-only'
                ? { _tag: 'RustJob', mode, result }
                : {
                    _tag: 'RustJob',
                    mode,
                    result,
                    cancel: () => {
                      Deferred.doneUnsafe(cancelStarted, Effect.void)
                      return new Promise<void>(() => undefined)
                    },
                  }
            })
            .pipe(Effect.forkChild({ startImmediately: true }))
          const interrupting = yield* Fiber.interrupt(waiting).pipe(
            Effect.forkChild({ startImmediately: true }),
          )
          if (mode === 'abortable') yield* Deferred.await(cancelStarted)
          expect((yield* runtime.snapshot).jobs).toBe(1)
          gate.resolve()
          yield* Fiber.join(interrupting)
          expect(yield* runtime.call(({ api }) => api.value(42))).toBe(42)
          expect(yield* runtime.snapshot).toMatchObject({
            generation: 2,
            jobs: 0,
            state: 'healthy',
          })
        }),
    )
  }

  it.effect('scheduler traps honor permanent retirement', () =>
    Effect.gen(function* () {
      const fixture = fake()
      const runtime = yield* makeRuntime('test/scheduler-retire', {
        load: fixture.load,
        panicPolicy: 'retire',
      })
      assertDefect(yield* Effect.exit(runtime.call(({ api }) => api.trapOnPoll())))
      assertDefect(yield* Effect.exit(runtime.call(({ api }) => api.value(42))))
      expect(fixture.counts()).toEqual({ loads: 1, releases: 1, live: 0 })
    }),
  )

  it.effect('does not run Rust destructors through a handle poisoned by a wasm trap', () =>
    Effect.gen(function* () {
      const fixture = fake()
      const runtime = yield* makeRuntime('test', { load: fixture.load })
      let destructors = 0
      const sink = runtime.inputSink(({ api }) => ({
        write: () => api.trap(),
        finish: () => 0,
        close: () => {
          destructors++
        },
      }))
      assertDefect(yield* Effect.exit(Stream.run(Stream.make(new Uint8Array([1])), sink)))
      expect(destructors).toBe(0)
      expect(yield* runtime.call(({ api }) => api.value(17))).toBe(17)
      expect(fixture.counts().releases).toBe(1)
    }),
  )

  it.effect('retire policy never reloads and rebuild failure is a defect, not Init', () =>
    Effect.gen(function* () {
      const fixture = fake()
      const retired = yield* makeRuntime('test', { load: fixture.load, panicPolicy: 'retire' })
      assertDefect(yield* Effect.exit(retired.callSync((api) => api.trap())))
      assertDefect(yield* Effect.exit(retired.callSync((api) => api.value(7))))
      expect(fixture.counts().loads).toBe(1)
      let attempts = 0
      const runtime = yield* makeRuntime('test', {
        load: () => {
          if (attempts++ > 0) throw new Error('rebuild failed')
          return fixture.load()
        },
      })
      assertDefect(yield* Effect.exit(runtime.callSync((api) => api.trap())))
      assertDefect(yield* Effect.exit(runtime.callSync((api) => api.value(7))))
      expect(attempts).toBe(2)
    }),
  )

  it.effect('awaits Rust cancellation acknowledgment with no live handles after 1000 cycles', () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime('test', {
        load: () => ({ api: undefined, release: () => undefined }),
      })
      let live = 0
      for (let index = 0; index < 1000; index++) {
        const started = yield* Deferred.make<void>()
        const operation = runtime.call((): RustJob<number> => {
          live++
          Deferred.doneUnsafe(started, Effect.void)
          return {
            _tag: 'RustJob',
            mode: 'abortable',
            result: new Promise<number>(() => undefined),
            cancel: async () => {
              await Promise.resolve()
              live--
            },
          }
        })
        const fiber = yield* operation.pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
        expect(live).toBe(0)
      }
      expect((yield* runtime.snapshot).jobs).toBe(0)
    }),
  )

  it.effect('settle-only interruption waits for completion rather than leaving Rust live', () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime('test', {
        load: () => ({ api: undefined, release: () => undefined }),
      })
      const started = yield* Deferred.make<void>()
      let complete: (value: number) => void = () => undefined
      let live = 0
      const job = yield* runtime
        .call(() => {
          live++
          Deferred.doneUnsafe(started, Effect.void)
          return new Promise<number>((resolve) => {
            complete = (value) => {
              live--
              resolve(value)
            }
          })
        })
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)
      let interrupted = false
      const interruption = yield* Fiber.interrupt(job).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            interrupted = true
          }),
        ),
        Effect.forkChild({ startImmediately: true }),
      )
      yield* Effect.yieldNow
      expect(interrupted).toBe(false)
      expect(live).toBe(1)
      complete(9)
      yield* Fiber.join(interruption)
      expect(interrupted).toBe(true)
      expect(live).toBe(0)
      expect((yield* runtime.snapshot).jobs).toBe(0)
    }),
  )
})

describe('Sink and Stream byte backpressure', () => {
  it.effect('splits input by profile and waits for write acknowledgment before pulling again', () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime('test', {
        load: () => ({ api: undefined, release: () => undefined }),
        chunkProfile: 'latency',
        byteBudget: chunkProfiles.latency,
      })
      const writing = yield* Deferred.make<void>()
      const proceed = yield* Deferred.make<void>()
      const runPromise = Effect.runPromiseWith(yield* Effect.context<never>())
      let pulled = 0
      const sizes: number[] = []
      let finished = false
      const sink = runtime.inputSink(() => ({
        write: (bytes) => {
          sizes.push(bytes.byteLength)
          if (sizes.length === 1) {
            Deferred.doneUnsafe(writing, Effect.void)
            return runPromise(Deferred.await(proceed))
          }
          return undefined
        },
        finish: () => {
          finished = true
          return sizes.reduce((sum, size) => sum + size, 0)
        },
        close: () => {
          throw new Error('finish consumes the handle; must not close twice')
        },
      }))
      const source = Stream.unfold(0, (index) =>
        Effect.sync(() => {
          if (index === 2) return undefined
          pulled++
          return [new Uint8Array(chunkProfiles.latency + 17), index + 1] as const
        }),
      )
      const fiber = yield* Stream.run(source, sink).pipe(Effect.forkChild)
      yield* Deferred.await(writing)
      expect(pulled).toBe(1)
      expect(sizes).toEqual([65536])
      yield* Deferred.succeed(proceed, undefined)
      expect(yield* Fiber.join(fiber)).toBe(2 * (65536 + 17))
      expect(sizes).toEqual([65536, 17, 65536, 17])
      expect(finished).toBe(true)
      expect((yield* runtime.snapshot).handles).toBe(0)
    }),
  )

  it.effect('does not prefetch and shares a byte budget across concurrent output streams', () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime('test', {
        load: () => ({ api: undefined, release: () => undefined }),
        chunkProfile: 'bulk',
        byteBudget: chunkProfiles.bulk,
      })
      const first = yield* Deferred.make<void>()
      const proceed = yield* Deferred.make<void>()
      let nextA = 0
      let nextB = 0
      let closed = 0
      const outputA = runtime.outputStream((_, profile) => {
        expect(profile).toBe(262144)
        return {
          next: (limit) => {
            nextA++
            return nextA === 1 ? new Uint8Array(limit).fill(3) : undefined
          },
          close: () => {
            closed++
          },
        }
      })
      const outputB = runtime.outputStream(() => ({
        next: (limit) => {
          nextB++
          return nextB === 1 ? new Uint8Array(limit).fill(4) : undefined
        },
        close: () => {
          closed++
        },
      }))
      const a = yield* Stream.runForEach(outputA, (bytes) =>
        Effect.gen(function* () {
          expect(bytes[0]).toBe(3)
          yield* Deferred.succeed(first, undefined)
          yield* Deferred.await(proceed)
        }),
      ).pipe(Effect.forkChild)
      yield* Deferred.await(first)
      const b = yield* Stream.runCollect(outputB).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.yieldNow
      expect(nextA).toBe(1)
      expect(nextB).toBe(0)
      yield* Deferred.succeed(proceed, undefined)
      yield* Fiber.join(a)
      const bytes = yield* Fiber.join(b)
      expect(bytes[0]?.byteLength).toBe(262144)
      expect(bytes[0]?.[0]).toBe(4)
      expect(nextA).toBe(2)
      expect(nextB).toBe(2)
      expect(closed).toBe(2)
      expect((yield* runtime.snapshot).handles).toBe(0)
    }),
  )

  it.effect('interrupted output consumers release their held byte budget and Rust handle', () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime('test', {
        load: () => ({ api: undefined, release: () => undefined }),
        byteBudget: chunkProfiles.latency,
      })
      const consumed = yield* Deferred.make<void>()
      let closed = 0
      const output = runtime.outputStream(() => ({
        next: (limit) => new Uint8Array(limit).fill(7),
        close: () => {
          closed++
        },
      }))
      const consumer = yield* Stream.runForEach(output, () =>
        Deferred.succeed(consumed, undefined).pipe(Effect.andThen(Effect.never)),
      ).pipe(Effect.forkChild)
      yield* Deferred.await(consumed)
      yield* Fiber.interrupt(consumer)
      expect(closed).toBe(1)
      const next = yield* Stream.runCollect(output.pipe(Stream.take(1)))
      expect(next[0]?.[0]).toBe(7)
      expect(closed).toBe(2)
      expect((yield* runtime.snapshot).handles).toBe(0)
    }),
  )
})

describe('scoped resources', () => {
  for (const panicBoundary of ['wasm', 'native'] as const) {
    it.effect(`${panicBoundary} resource shutdown is atomic at every scheduler boundary`, () =>
      Effect.gen(function* () {
        let forcedYields = 0
        // Walk every primitive around the finalizer, including Suspend -> Callback.
        for (let yieldAt = 1; yieldAt <= 64; yieldAt++) {
          const runtimeScope = yield* Scope.make()
          const resourceScope = yield* Scope.make()
          let closes = 0
          const runtime = yield* makeRuntime('scheduler-resource-close', {
            panicBoundary,
            load: () => ({ api: undefined, release: () => undefined }),
          }).pipe(Scope.provide(runtimeScope))
          yield* runtime
            .resource(() => ({
              close: () => {
                closes++
              },
            }))
            .pipe(Scope.provide(resourceScope))
          const paused = Promise.withResolvers<boolean>()
          const defaultScheduler = new Scheduler.MixedScheduler()
          let checks = 0
          let pauseRequested = false
          let resumeTask: (() => void) | undefined
          const controlled: Scheduler.Scheduler = {
            executionMode: 'async',
            shouldYield: () => {
              if (++checks !== yieldAt) return false
              pauseRequested = true
              return true
            },
            makeDispatcher: () => {
              const dispatcher = defaultScheduler.makeDispatcher()
              return {
                scheduleTask: (task, priority) => {
                  if (pauseRequested === true) {
                    resumeTask = () => {
                      pauseRequested = false
                      dispatcher.scheduleTask(task, priority)
                    }
                    paused.resolve(true)
                  } else dispatcher.scheduleTask(task, priority)
                },
                flush: () => dispatcher.flush(),
              }
            },
          }
          const finalizer = yield* Scope.close(resourceScope, Exit.void).pipe(
            Effect.provideService(Scheduler.Scheduler, controlled),
            Effect.forkChild({ startImmediately: true }),
          )
          const didPause = yield* Effect.raceFirst(
            Effect.promise(() => paused.promise),
            Fiber.await(finalizer).pipe(Effect.as(false)),
          )
          // The resource finalizer has started, but its next primitive cannot run
          // until the runtime has completed shutdown on the ordinary scheduler.
          yield* Scope.close(runtimeScope, Exit.void)
          if (didPause === true) {
            forcedYields++
            resumeTask!()
          }
          const exit = yield* Fiber.await(finalizer)
          expect(Exit.isSuccess(exit), `finalizer yield ${yieldAt}`).toBe(true)
          expect(closes, `destructor yield ${yieldAt}`).toBe(1)
        }
        expect(forcedYields).toBeGreaterThan(0)
      }),
    )

    it.effect(
      `${panicBoundary} synchronous acquisition owns the created handle before shutdown at every scheduler boundary`,
      () =>
        Effect.gen(function* () {
          let shutdownBoundaries = 0
          let completedWithoutYield = 0
          let maxChecks = 0
          // Include the entire acquisition, not just a hand-picked primitive.
          // The final assertion fails if a longer implementation outgrows this sweep.
          for (let yieldAt = 1; yieldAt <= 128; yieldAt++) {
            const runtimeScope = yield* Scope.make()
            const resourceScope = yield* Scope.make()
            let created = 0
            let live = 0
            let closes = 0
            let releases = 0
            let closesAfterRelease = 0
            const releaseObservations: { live: number; closes: number }[] = []
            const runtime = yield* makeRuntime('scheduler-resource-acquire', {
              panicBoundary,
              load: () => ({
                api: undefined,
                release: () => {
                  releaseObservations.push({ live, closes })
                  releases++
                },
              }),
            }).pipe(Scope.provide(runtimeScope))
            const controlled = makeBoundaryScheduler(yieldAt)
            const acquisition = yield* runtime
              .resource(() => {
                // This models the physical Rust allocation, before open returns.
                created++
                live++
                return {
                  close: () => {
                    if (releases !== 0) closesAfterRelease++
                    closes++
                    live--
                  },
                }
              })
              .pipe(
                Scope.provide(resourceScope),
                Effect.provideService(Scheduler.Scheduler, controlled.scheduler),
                Effect.forkChild({ startImmediately: true }),
              )
            const didPause = yield* Effect.raceFirst(
              Effect.promise(() => controlled.paused),
              Fiber.await(acquisition).pipe(Effect.as(false)),
            )
            let registeredBeforeShutdown: number | undefined
            const shutdownWhilePaused = didPause === true && created === 1
            if (shutdownWhilePaused === true) {
              shutdownBoundaries++
              registeredBeforeShutdown = (yield* runtime.snapshot).handles
              // Never close the runtime at a pre-constructor boundary: that would
              // merely test admission rejection, not ownership of a real handle.
              yield* Scope.close(runtimeScope, Exit.void)
            }
            if (didPause === true) controlled.resume()
            else completedWithoutYield++
            const acquisitionExit = yield* Fiber.await(acquisition)
            controlled.stop()
            if (shutdownWhilePaused === false) {
              yield* Scope.close(runtimeScope, Exit.void)
            }
            const finalizerExit = yield* Effect.exit(Scope.close(resourceScope, Exit.void))
            const counts = controlled.counts()
            maxChecks = Math.max(maxChecks, counts.checks)
            expect(counts.forcedYields, `acquisition yield ${yieldAt}`).toBe(
              didPause === true ? 1 : 0,
            )
            expect(created, `physical acquisition yield ${yieldAt}`).toBe(1)
            // A racing acquisition may fail once shutdown retires its generation.
            // Its physical handle must still be owned and destroyed before release.
            if (shutdownWhilePaused === false) {
              expect(Exit.isSuccess(acquisitionExit), `acquisition yield ${yieldAt}`).toBe(true)
            }
            expect(Exit.isSuccess(finalizerExit), `acquisition finalizer yield ${yieldAt}`).toBe(
              true,
            )
            expect(
              { closes, live, releases, closesAfterRelease },
              `acquisition yield ${yieldAt}`,
            ).toEqual({ closes: 1, live: 0, releases: 1, closesAfterRelease: 0 })
            expect(releaseObservations, `ownership at release yield ${yieldAt}`).toEqual([
              { live: 0, closes: 1 },
            ])
            if (registeredBeforeShutdown !== undefined) {
              expect(registeredBeforeShutdown, `registration yield ${yieldAt}`).toBe(1)
            }
            expect(yield* runtime.snapshot).toMatchObject({
              state: 'closed',
              jobs: 0,
              handles: 0,
            })
          }
          expect(shutdownBoundaries).toBeGreaterThan(0)
          expect(completedWithoutYield).toBeGreaterThan(0)
          expect(maxChecks).toBeLessThan(128)
        }),
    )

    it.effect(
      `${panicBoundary} interrupted explicit close preserves destructor ownership at every scheduler boundary`,
      () =>
        Effect.gen(function* () {
          let interruptedBoundaries = 0
          let completedWithoutYield = 0
          let maxChecks = 0
          for (let yieldAt = 1; yieldAt <= 128; yieldAt++) {
            const runtimeScope = yield* Scope.make()
            const resourceScope = yield* Scope.make()
            let live = 0
            let closes = 0
            let releases = 0
            let closesAfterRelease = 0
            const releaseObservations: { live: number; closes: number }[] = []
            const runtime = yield* makeRuntime('scheduler-resource-interrupt-close', {
              panicBoundary,
              load: () => ({
                api: undefined,
                release: () => {
                  releaseObservations.push({ live, closes })
                  releases++
                },
              }),
            }).pipe(Scope.provide(runtimeScope))
            const resource = yield* runtime
              .resource(() => {
                live++
                return {
                  close: () => {
                    if (releases !== 0) closesAfterRelease++
                    closes++
                    live--
                  },
                }
              })
              .pipe(Scope.provide(resourceScope))
            const controlled = makeBoundaryScheduler(yieldAt)
            const earlyClose = yield* resource.close.pipe(
              Effect.provideService(Scheduler.Scheduler, controlled.scheduler),
              Effect.forkChild({ startImmediately: true }),
            )
            const didPause = yield* Effect.raceFirst(
              Effect.promise(() => controlled.paused),
              Fiber.await(earlyClose).pipe(Effect.as(false)),
            )
            if (didPause === true) {
              interruptedBoundaries++
              // startImmediately dispatches the interrupt on the ordinary scheduler
              // before the withheld close task resumes, even if close is masked.
              const interrupting = yield* Fiber.interrupt(earlyClose).pipe(
                Effect.forkChild({ startImmediately: true }),
              )
              controlled.resume()
              yield* Fiber.join(interrupting)
            } else completedWithoutYield++
            yield* Fiber.await(earlyClose)
            controlled.stop()
            const retryExit = yield* Effect.exit(resource.close)
            const finalizerExit = yield* Effect.exit(Scope.close(resourceScope, Exit.void))
            // Capture ownership while the generation is still healthy. Runtime
            // shutdown must not conceal a missed early destructor by doing it later.
            const beforeShutdown = {
              closes,
              live,
              releases,
              snapshot: yield* runtime.snapshot,
            }
            const counts = controlled.counts()
            maxChecks = Math.max(maxChecks, counts.checks)
            yield* Scope.close(runtimeScope, Exit.void)
            const staleCloseExit = yield* Effect.exit(resource.close)
            expect(counts.forcedYields, `close yield ${yieldAt}`).toBe(didPause === true ? 1 : 0)
            expect(Exit.isSuccess(retryExit), `subsequent close yield ${yieldAt}`).toBe(true)
            expect(Exit.isSuccess(finalizerExit), `scope finalizer yield ${yieldAt}`).toBe(true)
            expect(Exit.isSuccess(staleCloseExit), `post-release close yield ${yieldAt}`).toBe(true)
            expect(beforeShutdown, `live-runtime ownership yield ${yieldAt}`).toEqual({
              closes: 1,
              live: 0,
              releases: 0,
              snapshot: { generation: 1, state: 'healthy', jobs: 0, handles: 0 },
            })
            expect(
              { closes, live, releases, closesAfterRelease },
              `close yield ${yieldAt}`,
            ).toEqual({ closes: 1, live: 0, releases: 1, closesAfterRelease: 0 })
            expect(releaseObservations, `ownership at release yield ${yieldAt}`).toEqual([
              { live: 0, closes: 1 },
            ])
            expect(yield* runtime.snapshot).toMatchObject({
              state: 'closed',
              jobs: 0,
              handles: 0,
            })
          }
          expect(interruptedBoundaries).toBeGreaterThan(0)
          expect(completedWithoutYield).toBeGreaterThan(0)
          expect(maxChecks).toBeLessThan(128)
        }),
    )

    for (const finalizerStrategy of ['sequential', 'parallel'] as const) {
      it.effect(
        `${panicBoundary} shutdown owns resource destructors with ${finalizerStrategy} finalizers`,
        () =>
          Effect.gen(function* () {
            const runtimeScope = yield* Scope.make()
            const resourceScope = yield* Scope.make(finalizerStrategy)
            const shutdownStarted = Promise.withResolvers<void>()
            const resumeShutdown = Promise.withResolvers<void>()
            const jobStarted = yield* Deferred.make<void>()
            const closes = [0, 0]
            let releases = 0
            const runtime = yield* makeRuntime('concurrent-resource-close', {
              panicBoundary,
              load: () => ({
                api: undefined,
                release: () => {
                  expect(closes).toEqual([1, 1])
                  releases++
                },
              }),
            }).pipe(Scope.provide(runtimeScope))
            const resources = yield* Effect.forEach([0, 1], (index) =>
              runtime.resource(() => ({
                close: () => {
                  closes[index]!++
                },
              })),
            ).pipe(Scope.provide(resourceScope))
            const job = yield* runtime
              .call(() => {
                Deferred.doneUnsafe(jobStarted, Effect.void)
                return {
                  _tag: 'RustJob',
                  mode: 'abortable',
                  result: new Promise<never>(() => undefined),
                  cancel: () => {
                    shutdownStarted.resolve()
                    return resumeShutdown.promise
                  },
                } as const
              })
              .pipe(Effect.exit, Effect.forkChild)
            yield* Deferred.await(jobStarted)
            const closingRuntime = yield* Scope.close(runtimeScope, Exit.void).pipe(
              Effect.forkChild,
            )
            yield* Effect.promise(() => shutdownStarted.promise)
            yield* Scope.close(resourceScope, Exit.void).pipe(
              Effect.ensuring(Effect.sync(() => resumeShutdown.resolve())),
            )
            yield* Fiber.join(closingRuntime)
            yield* Effect.forEach(resources, (resource) => resource.close)
            expect({ closes, releases }).toEqual({ closes: [1, 1], releases: 1 })
            assertDefect(yield* Fiber.join(job))
          }),
      )
    }
  }

  it.effect('releases 1k scoped resources without retaining live handles or jobs', () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime('resource-stress', {
        load: () => ({ api: undefined, release: () => undefined }),
      })
      let live = 0
      for (let index = 0; index < 1000; index++) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const resource = yield* runtime.resource(() => {
              live++
              return {
                close: () => {
                  live--
                },
              }
            })
            expect((yield* runtime.snapshot).handles).toBe(1)
            yield* resource.call(() => index)
          }),
        )
      }
      expect(live).toBe(0)
      expect(yield* runtime.snapshot).toEqual({
        generation: 1,
        jobs: 0,
        handles: 0,
        state: 'healthy',
      })
    }),
  )

  it.effect('serializes calls and close, and rejects use after exactly one release', () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime('resource', {
        load: () => ({ api: undefined, release: () => undefined }),
      })
      const events: string[] = []
      const waiting = Promise.withResolvers<number>()
      const escaped = yield* Effect.scoped(
        Effect.gen(function* () {
          const resource = yield* runtime.resource(() => ({
            close: () => {
              events.push('close')
            },
          }))
          const first = yield* resource
            .call(() => {
              events.push('first:start')
              return waiting.promise.then((value) => {
                events.push('first:end')
                return value
              })
            })
            .pipe(Effect.forkChild({ startImmediately: true }))
          const second = yield* resource
            .call(() => {
              events.push('second')
              return 2
            })
            .pipe(Effect.forkChild({ startImmediately: true }))
          const closing = yield* resource.close.pipe(Effect.forkChild({ startImmediately: true }))
          expect(events).toEqual(['first:start'])
          waiting.resolve(1)
          expect(yield* Fiber.join(first)).toBe(1)
          expect(yield* Fiber.join(second)).toBe(2)
          yield* Fiber.join(closing)
          yield* resource.close
          assertDefect(yield* Effect.exit(resource.call(() => 3)))
          return resource
        }),
      )
      yield* escaped.close
      expect(events).toEqual(['first:start', 'first:end', 'second', 'close'])
    }),
  )

  it.effect(
    'resource traps poison siblings; rebuilt instances reject stale calls and destructors',
    () =>
      Effect.gen(function* () {
        const fixture = fake()
        const runtime = yield* makeRuntime('resource', { load: fixture.load })
        let closes = 0
        let staleCalls = 0
        const first = yield* runtime.resource(({ api }) => ({
          value: () => api.value(9),
          trap: () => api.trap(),
          close: () => {
            closes++
          },
        }))
        const sibling = yield* runtime.resource(({ api }) => ({
          value: () => {
            staleCalls++
            return api.value(10)
          },
          pending: () => api.pending(),
          close: () => {
            closes++
          },
        }))
        expect(yield* first.call(({ api }) => api.value())).toBe(9)
        const pending = yield* sibling
          .call(({ api }) => api.pending())
          .pipe(Effect.forkChild({ startImmediately: true }))
        assertDefect(yield* Effect.exit(first.call(({ api }) => api.trap())))
        assertDefect(yield* Fiber.await(pending))
        assertDefect(yield* Effect.exit(sibling.call(({ api }) => api.value())))
        yield* first.close
        yield* sibling.close
        expect({ closes, staleCalls }).toEqual({ closes: 0, staleCalls: 0 })
        const fresh = yield* runtime.resource(({ api }) => ({
          value: () => api.value(11),
          close: () => {
            closes++
          },
        }))
        expect(yield* fresh.call(({ api }) => api.value())).toBe(11)
        yield* fresh.close
        expect(closes).toBe(1)
        expect(fixture.counts()).toEqual({ loads: 2, releases: 1, live: 0 })
      }),
  )
})
