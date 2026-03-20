/**
 * Store Lock
 *
 * Keyed semaphore service for serializing concurrent access to shared store resources.
 * Prevents race conditions when multiple nested megarepo syncs access the same
 * bare repos or worktree paths concurrently.
 *
 * Provided once at the CLI command level (alongside Store) and shared across
 * all recursive syncMegarepo calls via Effect's dependency injection.
 */

import { Effect, Ref } from 'effect'

type Semaphore = Effect.Semaphore

/** Keyed semaphore registry — lazily creates one semaphore per key */
const makeKeyedSemaphoreRegistry = () =>
  Effect.gen(function* () {
    const mapRef = yield* Ref.make(new Map<string, Semaphore>())

    const withLock =
      (key: string) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
        Effect.gen(function* () {
          const sem = yield* Ref.modify(mapRef, (map) => {
            const existing = map.get(key)
            if (existing !== undefined) return [existing, map]
            const sem = Effect.unsafeMakeSemaphore(1)
            const newMap = new Map(map)
            newMap.set(key, sem)
            return [sem, newMap]
          })
          return yield* sem.withPermits(1)(effect)
        })

    return { withLock } as const
  })

export class StoreLock extends Effect.Service<StoreLock>()('megarepo/StoreLock', {
  effect: Effect.gen(function* () {
    const repoLocks = yield* makeKeyedSemaphoreRegistry()
    const worktreeLocks = yield* makeKeyedSemaphoreRegistry()

    return {
      /** Serialize bare repo clone/fetch operations per repo URL */
      withRepoLock: repoLocks.withLock,
      /** Serialize worktree creation per worktree path */
      withWorktreeLock: worktreeLocks.withLock,
    } as const
  }),
}) {}
