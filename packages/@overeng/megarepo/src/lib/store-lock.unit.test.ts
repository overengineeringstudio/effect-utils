import { it } from '@effect/vitest'
import { Effect, Ref } from 'effect'
import { describe, expect } from 'vitest'

import { StoreLock } from './store-lock.ts'

describe('StoreLock', () => {
  it.effect('serializes operations with the same key', () =>
    Effect.gen(function* () {
      const { withRepoLock } = yield* StoreLock
      const order: string[] = []

      yield* Effect.all(
        [
          withRepoLock('same-url')(
            Effect.gen(function* () {
              order.push('a-start')
              yield* Effect.yieldNow()
              order.push('a-end')
            }),
          ),
          withRepoLock('same-url')(
            Effect.gen(function* () {
              order.push('b-start')
              yield* Effect.yieldNow()
              order.push('b-end')
            }),
          ),
        ],
        { concurrency: 'unbounded' },
      )

      // Operations must not interleave — one completes before the other starts
      expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end'])
    }).pipe(Effect.provide(StoreLock.Default)),
  )

  it.effect('allows concurrent operations with different keys', () =>
    Effect.gen(function* () {
      const { withRepoLock } = yield* StoreLock
      const order: string[] = []

      yield* Effect.all(
        [
          withRepoLock('url-a')(
            Effect.gen(function* () {
              order.push('a-start')
              yield* Effect.yieldNow()
              order.push('a-end')
            }),
          ),
          withRepoLock('url-b')(
            Effect.gen(function* () {
              order.push('b-start')
              yield* Effect.yieldNow()
              order.push('b-end')
            }),
          ),
        ],
        { concurrency: 'unbounded' },
      )

      // Both start before either ends — concurrent execution with different keys
      expect(order).toEqual(['a-start', 'b-start', 'a-end', 'b-end'])
    }).pipe(Effect.provide(StoreLock.Default)),
  )

  it.effect('repo and worktree locks are independent', () =>
    Effect.gen(function* () {
      const { withRepoLock, withWorktreeLock } = yield* StoreLock
      const order: string[] = []

      yield* Effect.all(
        [
          withRepoLock('same-key')(
            Effect.gen(function* () {
              order.push('repo-start')
              yield* Effect.yieldNow()
              order.push('repo-end')
            }),
          ),
          withWorktreeLock('same-key')(
            Effect.gen(function* () {
              order.push('worktree-start')
              yield* Effect.yieldNow()
              order.push('worktree-end')
            }),
          ),
        ],
        { concurrency: 'unbounded' },
      )

      // Repo lock and worktree lock don't block each other (different registries)
      expect(order).toEqual(['repo-start', 'worktree-start', 'repo-end', 'worktree-end'])
    }).pipe(Effect.provide(StoreLock.Default)),
  )

  it.effect('shared service instance serializes access correctly', () =>
    Effect.gen(function* () {
      const counterRef = yield* Ref.make(0)
      const { withRepoLock } = yield* StoreLock

      const consumer = () =>
        withRepoLock('shared-url')(
          Effect.gen(function* () {
            const current = yield* Ref.get(counterRef)
            yield* Effect.yieldNow()
            yield* Ref.set(counterRef, current + 1)
          }),
        )

      yield* Effect.all(
        Array.from({ length: 10 }, () => consumer()),
        { concurrency: 'unbounded' },
      )

      // Without serialization, counter would be less than 10 due to races
      const finalCount = yield* Ref.get(counterRef)
      expect(finalCount).toBe(10)
    }).pipe(Effect.provide(StoreLock.Default)),
  )
})
