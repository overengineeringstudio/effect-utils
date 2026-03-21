/**
 * Store Lock
 *
 * Distributed semaphore service for serializing concurrent access to shared
 * store resources — both within a single process (concurrent fibers) and
 * across separate mr processes.
 *
 * Uses DistributedSemaphore with a file-system backing stored in
 * $MEGAREPO_STORE/.locks/. TTL-based permits auto-expire if a process crashes.
 *
 * Per-key semaphores are cached in-memory via SynchronizedRef for performance
 * (avoids repeated file-system holderId allocation). The file-system backing
 * handles cross-process and cross-fiber serialization.
 */

import { createHash } from 'node:crypto'

import { FileSystem, Path } from '@effect/platform'
import { Context, Duration, Effect, Layer, SynchronizedRef } from 'effect'

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

type Semaphore = Effect.Effect.Success<ReturnType<typeof DistributedSemaphore.make>>

/**
 * Context needed by both DistributedSemaphore and FileSystemBacking at runtime.
 * FileSystemBacking's operations (tryAcquire, release, etc.) internally yield
 * FileSystem + Path, so these must be available when withPermits runs.
 */
type BackingContext = DistributedSemaphoreBacking | FileSystem.FileSystem | Path.Path

/**
 * Create a keyed lock function backed by distributed semaphores.
 * Keys are hashed to avoid filesystem NAME_MAX limits.
 * A namespace prefix separates independent lock registries (e.g. repo vs worktree).
 * Semaphores are cached per-key via SynchronizedRef (atomic get-or-create).
 */
const makeKeyedLock = ({
  backingContext,
  namespace,
}: {
  backingContext: Context.Context<BackingContext>
  namespace: string
}) =>
  Effect.gen(function* () {
    const cache = yield* SynchronizedRef.make(new Map<string, Semaphore>())

    return (key: string) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
        Effect.gen(function* () {
          const hashedKey = `${namespace}/${hashKey(key)}`

          const semaphore = yield* SynchronizedRef.modifyEffect(cache, (map) => {
            const existing = map.get(hashedKey)
            if (existing !== undefined) return Effect.succeed([existing, map] as const)
            return DistributedSemaphore.make(hashedKey, { limit: 1, ttl: LOCK_TTL }).pipe(
              Effect.provide(backingContext),
              Effect.map((sem) => [sem, new Map(map).set(hashedKey, sem)] as const),
            )
          })

          return yield* semaphore
            .withPermits(1)(effect)
            .pipe(
              Effect.provide(backingContext),
              Effect.catchAllCause((cause) =>
                Effect.fail(new Error(`Store lock failed: ${cause}`)),
              ),
            ) as Effect.Effect<A, E, R>
        })
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
      const semaphoreBackingContext = yield* Layer.build(lockLayer)

      // FileSystemBacking operations (tryAcquire, release, etc.) internally
      // yield FileSystem + Path — merge these into the context so withPermits
      // has everything needed at runtime.
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const backingContext = semaphoreBackingContext.pipe(
        Context.add(FileSystem.FileSystem, fs),
        Context.add(Path.Path, path),
      )

      return {
        withRepoLock: yield* makeKeyedLock({ backingContext, namespace: 'repo' }),
        withWorktreeLock: yield* makeKeyedLock({ backingContext, namespace: 'worktree' }),
      } as const
    }),
  )
