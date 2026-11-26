import { afterEach, describe, expect, it, vi } from '@effect/vitest'
import { Effect, Exit, Fiber, Scope } from 'effect'

import { NotLeader } from './errors.ts'
import { exclusiveLock } from './WebLock.ts'

afterEach(() => vi.unstubAllGlobals())

describe('WebLock', () => {
  it.effect('holds the device lock until its owning scope closes', () =>
    Effect.gen(function* () {
      let held = false
      let released = Promise.resolve()
      vi.stubGlobal('navigator', {
        locks: {
          request: vi.fn(
            (
              name: string,
              options: { ifAvailable: boolean },
              callback: (lock: object) => Promise<void>,
            ) => {
              expect(name).toBe('device-identity')
              expect(options.ifAvailable).toBe(true)
              held = true
              released = callback({}).then(() => {
                held = false
              })
              return released
            },
          ),
        },
      })
      const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      )
      yield* exclusiveLock('device-identity').pipe(Scope.provide(scope))
      expect(held).toBe(true)
      yield* Scope.close(scope, Exit.void)
      yield* Effect.promise(() => released)
      expect(held).toBe(false)
    }),
  )

  it.effect('rejects another tab holding the same identity', () =>
    Effect.gen(function* () {
      vi.stubGlobal('navigator', {
        locks: {
          request: vi.fn(
            async (_name: string, _options: unknown, callback: (lock: null) => void) =>
              callback(null),
          ),
        },
      })
      const error = yield* Effect.flip(exclusiveLock('device-identity'))
      expect(error).toBeInstanceOf(NotLeader)
    }),
  )

  it.effect('does not claim ownership when the Web Lock API rejects', () =>
    Effect.gen(function* () {
      vi.stubGlobal('navigator', {
        locks: {
          request: async () => {
            throw new Error('permission denied')
          },
        },
      })
      expect(yield* Effect.flip(exclusiveLock('device-identity'))).toBeInstanceOf(NotLeader)
    }),
  )

  it.effect('releases a grant already queued when acquisition is interrupted', () =>
    Effect.gen(function* () {
      type Grant = (lock: object) => Promise<void> | undefined
      const requested = Promise.withResolvers<Grant>()
      const finished = Promise.withResolvers<void>()
      vi.stubGlobal('navigator', {
        locks: {
          request: vi.fn((_name: string, options: { ifAvailable: boolean }, grant: Grant) => {
            // The Web Locks API forbids combining `signal` with `ifAvailable`.
            expect(options).toEqual({ ifAvailable: true })
            requested.resolve(grant)
            return finished.promise
          }),
        },
      })
      const pending = yield* Effect.scoped(exclusiveLock('device-identity')).pipe(Effect.forkChild)
      const grant = yield* Effect.promise(() => requested.promise)
      yield* Fiber.interrupt(pending)
      // The already-queued browser callback must return without retaining the lock.
      expect(grant({})).toBeUndefined()
      finished.resolve()
    }),
  )

  it.effect('retains the documented fallback when Web Locks are unsupported', () =>
    Effect.gen(function* () {
      vi.stubGlobal('navigator', {})
      yield* exclusiveLock('unsupported')
    }),
  )
})
