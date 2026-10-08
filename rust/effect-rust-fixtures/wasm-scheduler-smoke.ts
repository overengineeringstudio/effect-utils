import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer } from 'effect'

import { Interop } from '@overeng/effect-rust'

/** Raw fixture API shared by the Node, Bun, browser, and workerd smoke harnesses. */
export interface SchedulerApi {
  readonly pendingJob: () => Interop.RustJob<number>
  readonly settleJob: (source: Interop.SourceCallback) => Interop.RustJob<Uint8Array>
  readonly panicFirstPoll: () => Interop.RustJob<number>
  readonly panicAfterHostAwait: (source: Interop.SourceCallback) => Interop.RustJob<number>
  readonly add: (left: number, right: number) => number
}

const check = (condition: boolean, message: string) =>
  condition === true ? Effect.void : Effect.die(new Error(message))

const checkDefect = <T, TError>(exit: Exit.Exit<T, TError>, message: string) =>
  check(Exit.isFailure(exit) === true && Cause.hasDies(exit.cause) === true, message)

class Scheduler extends Context.Service<Scheduler, Interop.Runtime<SchedulerApi>>()(
  'fixture/Scheduler',
) {}

const acquireRuntime = Effect.fn('fixture.acquireSchedulerRuntime')(function* ({
  load,
  runtime,
  panicPolicy = 'rebuild',
}: {
  readonly load: Interop.InstanceFactory<SchedulerApi>
  readonly runtime: 'node' | 'bun' | 'browser' | 'browserWorker' | 'workerd'
  readonly panicPolicy?: Interop.PanicPolicy
}) {
  const context = yield* Layer.build(
    Interop.wasmLayer[runtime](Scheduler, { load, panicPolicy, make: (core) => core }),
  )
  return Context.get(context, Scheduler)
})

/** Runs real Rust futures without Node APIs, so every host can exercise the same traps. */
export const wasmSchedulerSmoke = Effect.fn('fixture.wasmSchedulerSmoke')(function* ({
  load,
  runtime,
}: {
  readonly load: Interop.InstanceFactory<SchedulerApi>
  readonly runtime: 'node' | 'bun' | 'browser' | 'browserWorker' | 'workerd'
}) {
  for (const panicPolicy of ['rebuild', 'retire'] as const) {
    for (const poll of ['first', 'after-host-await'] as const) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          let loads = 0
          let releases = 0
          const core = yield* acquireRuntime({
            runtime,
            panicPolicy,
            load: async () => {
              loads++
              const instance = await load()
              return {
                ...instance,
                release: () => {
                  releases++
                  return instance.release()
                },
              }
            },
          })
          const independent = yield* acquireRuntime({ runtime, load })
          const heldStarted = yield* Deferred.make<void>()
          const heldFinish = yield* Deferred.make<Uint8Array>()
          const panicStarted = yield* Deferred.make<void>()
          const panicFinish = yield* Deferred.make<Uint8Array>()
          const source = yield* Interop.hostSource('settle-only', {
            read: (path) =>
              Effect.gen(function* () {
                if (path === '/panic') {
                  yield* Deferred.succeed(panicStarted, undefined)
                  return yield* Deferred.await(panicFinish)
                }
                yield* Deferred.succeed(heldStarted, undefined)
                return yield* Deferred.await(heldFinish)
              }),
            readRange: () => Effect.succeed(new Uint8Array()),
          })
          // Unblock held host Effects even if an assertion fails; Rust callbacks
          // that arrive after retirement must not re-enter the discarded glue.
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              yield* Deferred.succeed(heldFinish, new Uint8Array([1]))
              yield* Deferred.succeed(panicFinish, new Uint8Array([1]))
            }),
          )
          const pending = yield* core
            .call(({ api }) => api.pendingJob())
            .pipe(Effect.forkChild({ startImmediately: true }))
          const held = yield* core
            .call(({ api, signal }) => api.settleJob((request) => source.call(signal, request)))
            .pipe(Effect.forkChild({ startImmediately: true }))
          yield* Deferred.await(heldStarted)
          const panic = yield* core
            .call(({ api, signal }) =>
              poll === 'first'
                ? api.panicFirstPoll()
                : api.panicAfterHostAwait((request) => source.call(signal, request)),
            )
            .pipe(Effect.forkChild({ startImmediately: true }))
          if (poll === 'after-host-await') {
            yield* Deferred.await(panicStarted)
            const before = yield* core.snapshot
            yield* check(
              before.generation === 1 && before.jobs === 3 && before.state === 'healthy',
              'host await must precede the scheduler panic with three registered calls',
            )
            yield* Deferred.succeed(panicFinish, new Uint8Array([1]))
          }
          yield* checkDefect(yield* Fiber.await(panic), `${poll}: panic must defect`)
          yield* checkDefect(yield* Fiber.await(pending), `${poll}: pending sibling must defect`)
          yield* checkDefect(yield* Fiber.await(held), `${poll}: host-await sibling must defect`)
          if (panicPolicy === 'rebuild') {
            yield* check((yield* core.call(({ api }) => api.add(20, 22))) === 42, 'fresh generation must work')
            const after = yield* core.snapshot
            yield* check(
              after.generation === 2 && after.jobs === 0 && after.state === 'healthy',
              'rebuild must produce a fresh healthy generation without pending jobs',
            )
          } else {
            yield* checkDefect(
              yield* Effect.exit(core.call(({ api }) => api.add(20, 22))),
              'retire policy must not admit another call',
            )
          }
          yield* check(loads === (panicPolicy === 'rebuild' ? 2 : 1) && releases === 1, 'poison must release exactly its own generation')
          yield* Deferred.succeed(heldFinish, new Uint8Array([1]))
          yield* source.quiesce
          yield* Interop.eventLoopYield
          yield* check((yield* independent.call(({ api }) => api.add(20, 22))) === 42, 'another runtime must remain usable')
          yield* check((yield* independent.snapshot).generation === 1, 'panic must not rebuild another runtime')
          yield* check(loads === (panicPolicy === 'rebuild' ? 2 : 1), 'late retired callbacks must not poison the replacement')
        }),
      )
    }
  }

  yield* Effect.scoped(
    Effect.gen(function* () {
      const core = yield* acquireRuntime({ runtime, load })
      const started = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<Uint8Array>()
      const source = yield* Interop.hostSource('settle-only', {
        read: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            return yield* Deferred.await(finish)
          }),
        readRange: () => Effect.succeed(new Uint8Array()),
      })
      yield* Effect.addFinalizer(() => Deferred.succeed(finish, new Uint8Array([1])))
      const panic = yield* core
        .call(({ api, signal }) => api.panicAfterHostAwait((request) => source.call(signal, request)))
        .pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(started)
      const interruption = yield* Fiber.interrupt(panic).pipe(
        Effect.forkChild({ startImmediately: true }),
      )
      yield* check((yield* core.snapshot).jobs === 1, 'interruption must await settle-only acknowledgment before the trap')
      yield* Deferred.succeed(finish, new Uint8Array([1]))
      yield* Fiber.join(interruption)
      yield* check((yield* core.call(({ api }) => api.add(20, 22))) === 42, 'interrupted orphan must not block generation rebuild')
      const after = yield* core.snapshot
      yield* check(after.generation === 2 && after.jobs === 0 && after.state === 'healthy', 'interrupted orphan must leave no registered jobs')
    }),
  )
})

/** Promise entrypoint for browser and workerd delivery harnesses. */
export const runWasmSchedulerSmoke = (options: Parameters<typeof wasmSchedulerSmoke>[0]) =>
  Effect.runPromise(wasmSchedulerSmoke(options).pipe(Effect.timeout('10 seconds')))
