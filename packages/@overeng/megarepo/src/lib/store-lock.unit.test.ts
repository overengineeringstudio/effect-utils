import { it } from '@effect/vitest'
import { NodeContext } from '@effect/platform-node'
import { Effect, Ref } from 'effect'
import { describe, expect } from 'vitest'

import { EffectPath } from '@overeng/effect-path'

import { makeStoreLockLayer, StoreLock } from './store-lock.ts'

/** Provide StoreLock backed by a temp directory */
const withStoreLock = <A, E>(
  effect: Effect.Effect<A, E, StoreLock>,
): Effect.Effect<A, E, never> =>
  Effect.gen(function* () {
    const tmpDir = yield* Effect.sync(() => require('node:os').tmpdir())
    const basePath = EffectPath.unsafe.absoluteDir(`${tmpDir}/store-lock-test-${Date.now()}/`)
    return yield* effect.pipe(Effect.provide(makeStoreLockLayer(basePath)))
  }).pipe(Effect.provide(NodeContext.layer))

describe('StoreLock', () => {
  it.effect('serializes concurrent access to the same key', () =>
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
})
