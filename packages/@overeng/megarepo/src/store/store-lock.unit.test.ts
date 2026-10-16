import { it } from '@effect/vitest'
import { Effect, Ref } from 'effect'
import { describe, expect } from 'vitest'

import { InMemoryBacking } from '@overeng/utils/lock'

import { makeStoreLockLayerFromBacking, StoreLock } from './store-lock.ts'

/** Provide StoreLock backed by an in-memory distributed semaphore */
const withStoreLock = <A, E>(effect: Effect.Effect<A, E, StoreLock>): Effect.Effect<A, E, never> =>
  effect.pipe(Effect.provide(makeStoreLockLayerFromBacking(InMemoryBacking.layer)), Effect.scoped)

describe('StoreLock', () => {
  it.effect(
    'serializes concurrent access to the same key',
    () =>
      withStoreLock(
        Effect.gen(function* () {
          const counterRef = yield* Ref.make(0)
          const { withWorktreeLock } = yield* StoreLock

          const increment = () =>
            withWorktreeLock('shared-worktree')(
              Effect.gen(function* () {
                const current = yield* Ref.get(counterRef)
                yield* Effect.yieldNow
                yield* Ref.set(counterRef, current + 1)
              }),
            )

          yield* Effect.all(
            Array.from({ length: 10 }, () => increment()),
            { concurrency: 'unbounded' },
          )

          // Without serialization, counter would be less than 10 due to races
          const finalCount = yield* Ref.get(counterRef)
          expect(finalCount).toBe(10)
        }),
      ),
    { timeout: 30_000 },
  )

  it.effect('allows concurrent access with different keys', () =>
    withStoreLock(
      Effect.gen(function* () {
        const { withWorktreeLock } = yield* StoreLock
        const results: string[] = []

        yield* Effect.all(
          [
            withWorktreeLock('worktree-a')(Effect.sync(() => results.push('a'))),
            withWorktreeLock('worktree-b')(Effect.sync(() => results.push('b'))),
          ],
          { concurrency: 'unbounded' },
        )

        // Both complete (different keys don't block each other)
        expect(results.sort()).toEqual(['a', 'b'])
      }),
    ),
  )

  it.effect(
    'worktree lock serializes concurrent creation for same path (issue #423)',
    () =>
      withStoreLock(
        Effect.gen(function* () {
          const { withWorktreeLock } = yield* StoreLock
          const creationOrder: number[] = []

          /** Simulates two nested megarepos trying to create the same worktree */
          yield* Effect.forEach(
            Array.from(
              { length: 5 },
              (_, i) => () =>
                withWorktreeLock('/store/github.com/org/shared-member/refs/heads/main/')(
                  Effect.gen(function* () {
                    yield* Effect.yieldNow
                    creationOrder.push(i)
                  }),
                ),
            ),
            (f) => f(),
            { concurrency: 'unbounded' },
          )

          // All 5 ran exactly once, serialized (no duplicates, no drops)
          expect(creationOrder).toHaveLength(5)
          expect(new Set(creationOrder).size).toBe(5)
        }),
      ),
    { timeout: 30_000 },
  )
})
