import { describe, expect, it } from '@effect/vitest'
import { Cause, Context, Effect, Layer, Logger } from 'effect'
import { vi } from 'vitest'

import { AutomergeRepo } from './AutomergeRepo.ts'
import { RepoPersistenceError } from './errors.ts'
import { SafeStorageAdapter } from './SafeStorageAdapter.ts'

describe('AutomergeRepo scoped lifecycle', () => {
  it.live('always shuts down after flush failure and logs both typed lifecycle failures', () => {
    const errors: RepoPersistenceError[] = []
    const logger = Logger.make<unknown, void>((options) => {
      for (const reason of options.cause.reasons)
        if (Cause.isFailReason(reason) && reason.error instanceof RepoPersistenceError)
          errors.push(reason.error)
    })
    return Effect.gen(function* () {
      const flushFailure = new Error('flush rejected')
      const shutdownFailure = new Error('shutdown rejected')
      const spies = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(AutomergeRepo.layer({ network: [] }))
          const service = Context.get(context, AutomergeRepo)
          const flush = vi.spyOn(service.interop.repo, 'flush').mockRejectedValue(flushFailure)
          const shutdown = vi
            .spyOn(service.interop.repo, 'shutdown')
            .mockRejectedValue(shutdownFailure)
          return { flush, shutdown }
        }),
      )
      expect(spies.flush).toHaveBeenCalledOnce()
      expect(spies.shutdown).toHaveBeenCalledOnce()
      expect(errors.map(({ operation }) => operation)).toEqual(['flush', 'shutdown'])
      expect(errors.map(({ cause }) => cause)).toEqual([flushFailure, shutdownFailure])
    }).pipe(Effect.provide(Logger.layer([logger])))
  })

  it.live('still invokes the real shutdown disconnect path when its second flush rejects', () =>
    Effect.gen(function* () {
      const failure = new Error('disk failed')
      const spies = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(AutomergeRepo.layer({ network: [] }))
          const service = Context.get(context, AutomergeRepo)
          const flush = vi.spyOn(service.interop.repo, 'flush').mockRejectedValue(failure)
          const shutdown = vi.spyOn(service.interop.repo, 'shutdown')
          return { flush, shutdown }
        }),
      )
      expect(spies.shutdown).toHaveBeenCalledOnce()
      // Real Repo.shutdown disconnects adapters and calls flush itself.
      expect(spies.flush).toHaveBeenCalledTimes(2)
    }),
  )

  it.live('never acknowledges durable saves or flushes without persistent storage', () =>
    Effect.gen(function* () {
      for (const storage of [undefined, new SafeStorageAdapter({ make: () => undefined })]) {
        const context = yield* Layer.build(
          AutomergeRepo.layer({ network: [], ...(storage === undefined ? {} : { storage }) }),
        )
        const service = Context.get(context, AutomergeRepo)
        const handle = yield* service.create({ count: 1 })
        handle.change((doc) => {
          doc.count++
        })
        expect(handle.doc().count).toBe(2)
        expect(yield* Effect.flip(service.save(handle))).toBeInstanceOf(RepoPersistenceError)
        expect(yield* Effect.flip(service.flush)).toBeInstanceOf(RepoPersistenceError)
      }
    }),
  )

  it.live(
    'logs degraded adapter persistence at scope close rather than silently succeeding',
    () => {
      const failures: unknown[] = []
      const logger = Logger.make<unknown, void>((options) => {
        for (const reason of options.cause.reasons)
          if (Cause.isFailReason(reason)) failures.push(reason.error)
      })
      return Effect.gen(function* () {
        const failure = new Error('IndexedDB unavailable')
        const storage = new SafeStorageAdapter({
          make: () => {
            throw failure
          },
        })
        yield* Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(AutomergeRepo.layer({ storage, network: [] }))
            const service = Context.get(context, AutomergeRepo)
            const handle = yield* service.create({ count: 1 })
            const error = yield* Effect.flip(service.save(handle))
            expect(error.cause).toBe(failure)
          }),
        )
        expect(failures).toHaveLength(1)
        expect(failures[0]).toBeInstanceOf(RepoPersistenceError)
      }).pipe(Effect.provide(Logger.layer([logger])))
    },
  )
})
