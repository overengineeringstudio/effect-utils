import { describe, expect, it } from '@effect/vitest'
import { Context, Deferred, Effect, Exit, Scope } from 'effect'

import { hostCapability } from './host.ts'

describe('host capabilities', () => {
  // Model the external host's Promise/signal boundary, not an Effect-owned fiber.
  it('abortable callbacks await Effect finalizers on 1000 cancellation cycles', async () => {
    const scope = await Effect.runPromise(Scope.make())
    const runPromise = Effect.runPromiseWith(Context.make(Scope.Scope, scope))
    try {
      let live = 0
      let started = Deferred.makeUnsafe<void>()
      const source = await runPromise(
        hostCapability('abortable', () =>
          Effect.acquireRelease(
            Effect.sync(() => {
              live++
              Deferred.doneUnsafe(started, Effect.void)
            }),
            () =>
              Effect.promise(async () => {
                await Promise.resolve()
                live--
              }),
          ).pipe(Effect.andThen(Effect.never)),
        ),
      )
      for (let index = 0; index < 1000; index++) {
        started = Deferred.makeUnsafe<void>()
        const controller = new AbortController()
        const result = source.call(controller.signal).then(
          () => false,
          () => true,
        )
        await Effect.runPromise(Deferred.await(started))
        controller.abort()
        expect(await result).toBe(true)
        expect(live).toBe(0)
        expect(await Effect.runPromise(source.live)).toBe(0)
      }
      await Effect.runPromise(source.quiesce)
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
  })

  it('settle-only callbacks ignore abort and wait for the real operation to settle', async () => {
    const scope = await Effect.runPromise(Scope.make())
    const runPromise = Effect.runPromiseWith(Context.make(Scope.Scope, scope))
    try {
      const started = Deferred.makeUnsafe<void>()
      const finish = Deferred.makeUnsafe<number>()
      let finalized = false
      const source = await runPromise(
        hostCapability('settle-only', () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(finish)),
            Effect.ensuring(
              Effect.sync(() => {
                finalized = true
              }),
            ),
          ),
        ),
      )
      const controller = new AbortController()
      const result = source.call(controller.signal)
      await Effect.runPromise(Deferred.await(started))
      controller.abort()
      expect(await Effect.runPromise(source.live)).toBe(1)
      expect(finalized).toBe(false)
      await Effect.runPromise(Deferred.succeed(finish, 23))
      expect(await result).toBe(23)
      expect(finalized).toBe(true)
      expect(await Effect.runPromise(source.live)).toBe(0)
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
  })
})
