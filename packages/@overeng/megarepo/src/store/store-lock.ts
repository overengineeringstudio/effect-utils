/**
 * Worktree lifecycle gate.
 *
 * This gate coordinates worktree-level decisions within mr. Canonical Git
 * writers, including clone, use git-writer-lock.ts instead: its kernel flock
 * is the single cross-tool ownership boundary for each resolved common dir.
 * The legacy TTL-backed lifecycle gate is not a shared-ref writer lock and
 * cannot establish cross-process exclusion (the backing is read-then-write).
 */

import { createHash } from 'node:crypto'

import { Context, Duration, Effect, Layer, Semaphore, SynchronizedRef } from 'effect'

import type { AbsoluteDirPath } from '@overeng/effect-path'
import { DistributedSemaphore, DistributedSemaphoreBacking } from '@overeng/utils/lock'
import { FileSystemBacking } from '@overeng/utils/node'

/** Default TTL for store locks (auto-expires if process crashes) */
const LOCK_TTL = Duration.minutes(5)

/** Hash a key to a fixed-length string safe for filesystem NAME_MAX limits */
const hashKey = (key: string): string => createHash('sha256').update(key).digest('hex').slice(0, 32)

/** StoreLock service interface */
export interface StoreLockService {
  /** Serialize worktree creation per worktree path */
  readonly withWorktreeLock: (
    key: string,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

/** Distributed semaphore service for serializing concurrent access to shared store resources */
export class StoreLock extends Context.Service<StoreLock, StoreLockService>()(
  'megarepo/StoreLock',
) {}

type DistributedSem = Effect.Success<ReturnType<typeof DistributedSemaphore.make>>

interface CacheEntry {
  /** In-process fiber gate for lifecycle decisions */
  readonly gate: Semaphore.Semaphore
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
              const gate = yield* Semaphore.make(1)
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

const withoutPushAcquire = (
  backingContext: Context.Context<DistributedSemaphoreBacking>,
): Context.Context<DistributedSemaphoreBacking> => {
  const backing = Context.get(
    backingContext,
    DistributedSemaphoreBacking,
  ) as DistributedSemaphoreBacking
  const { onPermitsReleased: _onPermitsReleased, ...backingWithoutPush } = backing

  // Store locks are short critical sections; polling is slower but avoids
  // fs.watch edge cases on transient lock directories in CI and during GC.
  return Context.add(
    backingContext,
    DistributedSemaphoreBacking,
    backingWithoutPush as DistributedSemaphoreBacking & { readonly onPermitsReleased?: never },
  )
}

/**
 * Create the StoreLock layer from an arbitrary DistributedSemaphoreBacking layer.
 * Useful for testing with an in-memory backing.
 */
export const makeStoreLockLayerFromBacking = (
  backingLayer: Layer.Layer<DistributedSemaphoreBacking>,
) =>
  Layer.effect(
    StoreLock,
    Effect.gen(function* () {
      const backingContext = withoutPushAcquire(yield* Layer.build(backingLayer))

      return {
        withWorktreeLock: yield* makeKeyedLock({ backingContext, namespace: 'worktree' }),
      } as const
    }),
  )

/**
 * Create the StoreLock layer backed by file-system locks at the given path.
 * Lock files stored in {basePath}.locks/ directory.
 */
export const makeStoreLockLayer = (basePath: AbsoluteDirPath) =>
  Layer.effect(
    StoreLock,
    Effect.gen(function* () {
      const lockDir = `${basePath}.locks`
      const lockLayer = FileSystemBacking.layer({ lockDir })
      const backingContext = withoutPushAcquire(yield* Layer.build(lockLayer))

      return {
        withWorktreeLock: yield* makeKeyedLock({ backingContext, namespace: 'worktree' }),
      } as const
    }),
  )
