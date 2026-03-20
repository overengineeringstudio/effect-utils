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

import { createHash } from 'node:crypto'

import { Context, Duration, Effect, Layer, Ref } from 'effect'

import type { AbsoluteDirPath } from '@overeng/effect-path'
import { DistributedSemaphore, type DistributedSemaphoreBacking } from '@overeng/utils'
import { FileSystemBacking } from '@overeng/utils/node'

/** Default TTL for store locks (auto-expires if process crashes) */
const LOCK_TTL = Duration.minutes(5)

/** Hash a key to a fixed-length string safe for filesystem NAME_MAX limits */
const hashKey = (key: string): string => createHash('sha256').update(key).digest('hex').slice(0, 32)

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
 * Takes an eagerly-built backing context so withLock has no extra deps.
 * Keys are hashed to avoid filesystem NAME_MAX limits.
 */
const makeKeyedDistributedRegistry = (
  backingContext: Context.Context<DistributedSemaphoreBacking>,
) =>
  Effect.gen(function* () {
    type Semaphore = Effect.Effect.Success<ReturnType<typeof DistributedSemaphore.make>>
    const mapRef = yield* Ref.make(new Map<string, Semaphore>())

    const withLock =
      (key: string) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
        Effect.gen(function* () {
          const hashedKey = hashKey(key)

          let semaphore = yield* Ref.modify(mapRef, (map) => {
            const existing = map.get(hashedKey)
            if (existing !== undefined) return [existing, map] as const
            return [undefined, map] as const
          })

          if (semaphore === undefined) {
            semaphore = yield* DistributedSemaphore.make(hashedKey, {
              limit: 1,
              ttl: LOCK_TTL,
            }).pipe(Effect.provide(backingContext))
            yield* Ref.update(mapRef, (map) => new Map(map).set(hashedKey, semaphore!))
          }

          return yield* semaphore
            .withPermits(1)(effect)
            .pipe(Effect.provide(backingContext), Effect.orDie)
        })

    return { withLock } as const
  })

/**
 * Create the StoreLock layer backed by file-system locks at the given path.
 * Lock files stored in {basePath}.locks/ directory.
 */
export const makeStoreLockLayer = (basePath: AbsoluteDirPath) =>
  Layer.scoped(
    StoreLock,
    Effect.gen(function* () {
      const lockDir = `${basePath}.locks`
      const lockLayer = FileSystemBacking.layer({ lockDir })
      const backingContext = yield* Layer.build(lockLayer)

      const repoLocks = yield* makeKeyedDistributedRegistry(backingContext)
      const worktreeLocks = yield* makeKeyedDistributedRegistry(backingContext)

      return {
        withRepoLock: repoLocks.withLock,
        withWorktreeLock: worktreeLocks.withLock,
      } as const
    }),
  )
