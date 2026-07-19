import { createHash } from 'node:crypto'

import { FileSystem } from '@effect/platform'
import { NodeContext } from '@effect/platform-node'
import { it } from '@effect/vitest'
import { Deferred, Duration, Effect, Ref, TestClock } from 'effect'
import { describe, expect } from 'vitest'

import { EffectPath } from '@overeng/effect-path'
import { InMemoryBacking } from '@overeng/utils'

import { makeStoreLockLayer, makeStoreLockLayerFromBacking, StoreLock } from './store-lock.ts'

/** Provide StoreLock backed by an in-memory distributed semaphore */
const withStoreLock = <A, E>(effect: Effect.Effect<A, E, StoreLock>): Effect.Effect<A, E, never> =>
  effect.pipe(Effect.provide(makeStoreLockLayerFromBacking(InMemoryBacking.layer)), Effect.scoped)

const hashStoreLockKey = (key: string): string =>
  createHash('sha256').update(key).digest('hex').slice(0, 32)

describe('StoreLock', () => {
  it.effect(
    'serializes concurrent access to the same key',
    () =>
      withStoreLock(
        Effect.gen(function* () {
          const counterRef = yield* Ref.make(0)
          const { withRepoLock } = yield* StoreLock

          const increment = () =>
            withRepoLock('shared-url')(
              Effect.gen(function* () {
                const current = yield* Ref.get(counterRef)
                yield* Effect.yieldNow()
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
        const { withRepoLock } = yield* StoreLock
        const results: string[] = []

        yield* Effect.all(
          [
            withRepoLock('url-a')(Effect.sync(() => results.push('a'))),
            withRepoLock('url-b')(Effect.sync(() => results.push('b'))),
          ],
          { concurrency: 'unbounded' },
        )

        // Both complete (different keys don't block each other)
        expect(results.sort()).toEqual(['a', 'b'])
      }),
    ),
  )

  it.effect('repo and worktree locks are independent registries', () =>
    withStoreLock(
      Effect.gen(function* () {
        const { withRepoLock, withWorktreeLock } = yield* StoreLock
        const results: string[] = []

        yield* Effect.all(
          [
            withRepoLock('same-key')(Effect.sync(() => results.push('repo'))),
            withWorktreeLock('same-key')(Effect.sync(() => results.push('worktree'))),
          ],
          { concurrency: 'unbounded' },
        )

        // Both complete (repo and worktree are separate registries)
        expect(results.sort()).toEqual(['repo', 'worktree'])
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
          yield* Effect.all(
            Array.from(
              { length: 5 },
              (_, i) => () =>
                withWorktreeLock('/store/github.com/org/shared-member/refs/heads/main/')(
                  Effect.gen(function* () {
                    yield* Effect.yieldNow()
                    creationOrder.push(i)
                  }),
                ),
            ).map((f) => f()),
            { concurrency: 'unbounded' },
          )

          // All 5 ran exactly once, serialized (no duplicates, no drops)
          expect(creationOrder).toHaveLength(5)
          expect(new Set(creationOrder).size).toBe(5)
        }),
      ),
    { timeout: 30_000 },
  )

  it.effect(
    'interrupts an in-flight file-system refresh before releasing a StoreLock holder',
    () =>
      Effect.gen(function* () {
        const baseFs = yield* FileSystem.FileSystem
        const tempDir = yield* baseFs.makeTempDirectoryScoped()
        const storePath = EffectPath.unsafe.absoluteDir(`${tempDir}/store/`)
        const lockKey = 'https://github.com/acme/widget.git'
        const keyDir = `${storePath}.locks/${encodeURIComponent(
          `repo/${hashStoreLockKey(lockKey)}`,
        )}`
        const refreshRenameReady = yield* Deferred.make<void>()
        const allowRefreshRename = yield* Deferred.make<void>()
        const refreshDone = yield* Deferred.make<'interrupted' | 'renamed'>()
        let holderRenameCount = 0

        const isHolderLockRename = (oldPath: string, newPath: string) =>
          oldPath.endsWith('.tmp') === true &&
          newPath.startsWith(`${keyDir}/`) === true &&
          newPath.endsWith('.lock') === true

        const isHolderLockRemove = (filePath: string) =>
          filePath.startsWith(`${keyDir}/`) === true && filePath.endsWith('.lock') === true

        const instrumentedFs = {
          ...baseFs,
          rename: (oldPath: string, newPath: string) => {
            if (isHolderLockRename(oldPath, newPath) === false) {
              return baseFs.rename(oldPath, newPath)
            }

            holderRenameCount += 1
            if (holderRenameCount !== 2) {
              return baseFs.rename(oldPath, newPath)
            }

            return Effect.gen(function* () {
              yield* Deferred.succeed(refreshRenameReady, undefined)
              yield* Deferred.await(allowRefreshRename)
              yield* baseFs.rename(oldPath, newPath)
              yield* Deferred.succeed(refreshDone, 'renamed')
            }).pipe(
              Effect.onInterrupt(() =>
                Deferred.succeed(refreshDone, 'interrupted').pipe(Effect.asVoid),
              ),
            )
          },
          remove: (filePath: string) => {
            if (isHolderLockRemove(filePath) === false) {
              return baseFs.remove(filePath)
            }

            return Effect.gen(function* () {
              yield* baseFs.remove(filePath)
              yield* Deferred.succeed(allowRefreshRename, undefined)
              yield* Deferred.await(refreshDone)
            })
          },
        } as FileSystem.FileSystem

        yield* Effect.gen(function* () {
          const { withRepoLock } = yield* StoreLock

          yield* withRepoLock(lockKey)(
            Effect.gen(function* () {
              yield* TestClock.adjust(Duration.seconds(101))
              yield* Deferred.await(refreshRenameReady)
            }),
          )

          const refreshResult = yield* Deferred.await(refreshDone)
          const remainingHolderLocks = yield* baseFs
            .readDirectory(keyDir)
            .pipe(Effect.catchAll(() => Effect.succeed([] as Array<string>)))

          expect(refreshResult).toBe('interrupted')
          expect(remainingHolderLocks.filter((entry) => entry.endsWith('.lock'))).toEqual([])

          const secondAcquireResult = yield* withRepoLock(lockKey)(Effect.succeed('acquired'))

          expect(secondAcquireResult).toBe('acquired')
        }).pipe(
          Effect.provide(makeStoreLockLayer(storePath)),
          Effect.provideService(FileSystem.FileSystem, instrumentedFs),
        )
      }).pipe(Effect.provide(NodeContext.layer), Effect.scoped),
    { timeout: 20_000 },
  )
})
