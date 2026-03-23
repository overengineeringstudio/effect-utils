/**
 * Store Lock
 *
 * Serializes concurrent access to shared store resources — both within a
 * single process (concurrent fibers) and across separate mr processes.
 *
 * Two-layer locking:
 * - In-process: Effect.Semaphore per key — guarantees fiber serialization
 * - Cross-process: DistributedSemaphore with file-system backing at
 *   $MEGAREPO_STORE/.locks/ — best-effort cross-process coordination
 *
 * The in-process gate is the primary correctness mechanism. The distributed
 * lock's FileSystemBacking has a TOCTOU race in tryAcquire (read-then-write
 * are not atomic), but the in-process gate ensures only one fiber enters
 * tryAcquire at a time, making the race harmless.
 */

import { createHash } from 'node:crypto'

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

type DistributedSem = Effect.Effect.Success<ReturnType<typeof DistributedSemaphore.make>>

interface CacheEntry {
  /** In-process fiber gate — primary correctness mechanism */
  readonly gate: Effect.Semaphore
  /** Cross-process distributed lock — best-effort coordination */
  readonly distributed: DistributedSem
}

/**
 * Create a keyed lock function with two-layer serialization.
 * Keys are hashed to avoid filesystem NAME_MAX limits.
 * A namespace prefix separates independent lock registries (e.g. repo vs worktree).
 * Entries are cached per-key via SynchronizedRef (atomic get-or-create).
 */
const makeKeyedLock = ({
  backingContext,
  namespace,
}: {
  backingContext: Context.Context<DistributedSemaphoreBacking>
  namespace: string
}) =>
  Effect.gen(function* () {
    const cache = yield* SynchronizedRef.make(new Map<string, CacheEntry>())

    return (key: string) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
        Effect.gen(function* () {
          const hashedKey = `${namespace}/${hashKey(key)}`

          const entry = yield* SynchronizedRef.modifyEffect(cache, (map) => {
            const existing = map.get(hashedKey)
            if (existing !== undefined) return Effect.succeed([existing, map] as const)
            return Effect.gen(function* () {
              const gate = yield* Effect.makeSemaphore(1)
              const distributed = yield* DistributedSemaphore.make(hashedKey, {
                limit: 1,
                ttl: LOCK_TTL,
              }).pipe(Effect.provide(backingContext))
              const newEntry: CacheEntry = { gate, distributed }
              return [newEntry, new Map(map).set(hashedKey, newEntry)] as const
            })
          })

          // In-process gate prevents TOCTOU race in the distributed backing's tryAcquire
          return yield* entry.gate.withPermits(1)(
            entry.distributed.withPermits(1)(effect).pipe(Effect.provide(backingContext)),
          ) as Effect.Effect<A, E, R>
        })
  })

/**
 * Create the StoreLock layer from an arbitrary DistributedSemaphoreBacking layer.
 * Useful for testing with an in-memory backing.
 */
export const makeStoreLockLayerFromBacking = (
  backingLayer: Layer.Layer<DistributedSemaphoreBacking>,
) =>
  Layer.scoped(
    StoreLock,
    Effect.gen(function* () {
      const backingContext = yield* Layer.build(backingLayer)

      return {
        withRepoLock: yield* makeKeyedLock({ backingContext, namespace: 'repo' }),
        withWorktreeLock: yield* makeKeyedLock({ backingContext, namespace: 'worktree' }),
      } as const
    }),
  )

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

      return {
        withRepoLock: yield* makeKeyedLock({ backingContext, namespace: 'repo' }),
        withWorktreeLock: yield* makeKeyedLock({ backingContext, namespace: 'worktree' }),
      } as const
    }),
  )
