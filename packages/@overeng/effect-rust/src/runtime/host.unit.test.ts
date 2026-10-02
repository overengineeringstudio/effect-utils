import { describe, expect, it } from '@effect/vitest'
import { Deferred, Effect } from 'effect'

import { hostCapability } from './host.ts'

describe('host capabilities', () => {
  it.effect('abortable callbacks await Effect finalizers on 1000 cancellation cycles', () => Effect.gen(function* () {
    let live = 0
    let started = yield* Deferred.make<void>()
    const source = yield* hostCapability('abortable', () => Effect.acquireRelease(
      Effect.sync(() => { live++; Deferred.doneUnsafe(started, Effect.void) }),
      () => Effect.promise(async () => { await Promise.resolve(); live-- }),
    ).pipe(Effect.andThen(Effect.never)))
    for (let index = 0; index < 1000; index++) {
      started = yield* Deferred.make<void>()
      const controller = new AbortController()
      const result = source.call(controller.signal).then(() => false, () => true)
      yield* Deferred.await(started)
      controller.abort()
      expect(yield* Effect.promise(() => result)).toBe(true)
      expect(live).toBe(0)
      expect(yield* source.live).toBe(0)
    }
    yield* source.quiesce
  }))

  it.effect('settle-only callbacks ignore abort and wait for the real operation to settle', () => Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const finish = yield* Deferred.make<number>()
    let finalized = false
    const source = yield* hostCapability('settle-only', () => Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Deferred.await(finish)),
      Effect.ensuring(Effect.sync(() => { finalized = true })),
    ))
    const controller = new AbortController()
    const result = source.call(controller.signal)
    yield* Deferred.await(started)
    controller.abort()
    expect(yield* source.live).toBe(1)
    expect(finalized).toBe(false)
    yield* Deferred.succeed(finish, 23)
    expect(yield* Effect.promise(() => result)).toBe(23)
    expect(finalized).toBe(true)
    expect(yield* source.live).toBe(0)
  }))
})
