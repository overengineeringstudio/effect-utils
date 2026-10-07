import { describe, expect, it } from '@effect/vitest'
import { Context, Deferred, Effect, Exit, Scope } from 'effect'

import { hostCapability, hostSource } from './host.ts'

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

  it('range requests reject noncanonical offsets and invalid u32 bounds before host dispatch', async () => {
    const scope = await Effect.runPromise(Scope.make())
    const runPromise = Effect.runPromiseWith(Context.make(Scope.Scope, scope))
    let calls = 0
    try {
      const source = await runPromise(
        hostSource('abortable', {
          read: () => Effect.succeed(new Uint8Array(0)),
          readRange: () =>
            Effect.sync(() => {
              calls++
              return new Uint8Array(0)
            }),
        }),
      )
      const signal = new AbortController().signal
      for (const offset of ['01', '-1', '+1', '1e3', '18446744073709551616']) {
        await expect(
          source.call(signal, { kind: 'readRange', path: 'file', offset, maxBytes: 1 }),
        ).rejects.toThrow('Invalid host Source request')
      }
      for (const maxBytes of [0, -1, 0.5, 4294967296, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(
          source.call(signal, { kind: 'readRange', path: 'file', offset: '0', maxBytes }),
        ).rejects.toThrow('Invalid host Source request')
      }
      expect(calls).toBe(0)
      await source.call(signal, {
        kind: 'readRange',
        path: 'file',
        offset: '18446744073709551615',
        maxBytes: 4294967295,
      })
      expect(calls).toBe(1)
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
  })

  it('yield lets an event-loop cancellation task run and scope closure leaves no pending host calls', async () => {
    const scope = await Effect.runPromise(Scope.make())
    const runPromise = Effect.runPromiseWith(Context.make(Scope.Scope, scope))
    const source = await runPromise(
      hostSource('abortable', {
        read: () => Effect.succeed(new Uint8Array(0)),
        readRange: () => Effect.succeed(new Uint8Array(0)),
      }),
    )
    const controller = new AbortController()
    // Real timers deliberately test the macrotask boundary, not Effect's clock.
    const cancelTask = setTimeout(() => controller.abort(), 0)
    try {
      await expect(source.call(controller.signal, { kind: 'yield' })).rejects.toThrow()
      expect(controller.signal.aborted).toBe(true)
      await Effect.runPromise(source.quiesce)
      expect(await Effect.runPromise(source.live)).toBe(0)
      const pending = source.call(new AbortController().signal, { kind: 'yield' }).then(
        () => false,
        () => true,
      )
      await Effect.runPromise(Scope.close(scope, Exit.void))
      expect(await pending).toBe(true)
      expect(await Effect.runPromise(source.live)).toBe(0)
      await expect(source.call(new AbortController().signal, { kind: 'yield' })).rejects.toThrow(
        'scope is closed',
      )
    } finally {
      clearTimeout(cancelTask)
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
  })
})
