/**
 * Store Lock
 *
 * Distributed semaphore service for serializing concurrent access to shared
 * store resources — both within a single process (concurrent fibers) and
 * across separate mr processes.
 *
 * Uses effect-distributed-lock with a file-system backing stored in
 * $MEGAREPO_STORE/.locks/. TTL-based permits auto-expire if a process crashes.
 */

import { Context, Duration, Effect, Layer, Ref } from 'effect'

import type { AbsoluteDirPath } from '@overeng/effect-path'
import { DistributedSemaphore, DistributedSemaphoreBacking } from '@overeng/utils'
import { FileSystemBacking } from '@overeng/utils/node'

/** Default TTL for store locks (auto-expires if process crashes) */
const LOCK_TTL = Duration.minutes(5)

/** StoreLock service interface */
export interface StoreLockService {
  /** Serialize bare repo clone/fetch operations per repo URL */
  readonly withRepoLock: (
    key: string,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  /** Serialize worktree creation per worktree path */
  readonly withWorktreeLock: (
    key: string,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

/** Distributed semaphore service for serializing concurrent access to shared store resources */
export class StoreLock extends Context.Tag('megarepo/StoreLock')<StoreLock, StoreLockService>() {}

/**
 * Keyed distributed semaphore registry — lazily creates one DistributedSemaphore per key.
 * Each semaphore is backed by file-system locks for cross-process coordination.
 */
const makeKeyedDistributedRegistry = (lockLayer: Layer.Layer<DistributedSemaphoreBacking>) =>
  Effect.gen(function* () {
    type Semaphore = Effect.Effect.Success<ReturnType<typeof DistributedSemaphore.make>>
    const mapRef = yield* Ref.make(new Map<string, Semaphore>())

    const withLock =
      (key: string) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
        Effect.gen(function* () {
          let semaphore = yield* Ref.modify(mapRef, (map) => {
            const existing = map.get(key)
            if (existing !== undefined) return [existing, map] as const
            return [undefined, map] as const
          })

          if (semaphore === undefined) {
            semaphore = yield* DistributedSemaphore.make(key, {
              limit: 1,
              ttl: LOCK_TTL,
            }).pipe(Effect.provide(lockLayer))
            yield* Ref.update(mapRef, (map) => new Map(map).set(key, semaphore!))
          }

          return yield* semaphore.withPermits(1)(effect).pipe(Effect.provide(lockLayer))
        })

    return { withLock } as const
  })

/**
 * Create the StoreLock layer backed by file-system locks at the given path.
 * Lock files stored in {basePath}.locks/ directory.
 */
export const makeStoreLockLayer = (basePath: AbsoluteDirPath): Layer.Layer<StoreLock> =>
  Layer.effect(
    StoreLock,
    Effect.gen(function* () {
      const lockDir = `${basePath}.locks`
      const lockLayer = FileSystemBacking.layer({ lockDir })

      const repoLocks = yield* makeKeyedDistributedRegistry(lockLayer)
      const worktreeLocks = yield* makeKeyedDistributedRegistry(lockLayer)

      return {
        withRepoLock: repoLocks.withLock,
        withWorktreeLock: worktreeLocks.withLock,
      } as const
    }),
  )
