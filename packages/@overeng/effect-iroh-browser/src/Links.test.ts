import { describe, expect, it } from '@effect/vitest'
import { Deferred, Effect, Fiber, Stream, SubscriptionRef } from 'effect'

import { type Connection, fromFramed } from './Connection.ts'
import * as Links from './Links.ts'
import { connPair } from './testing.ts'

/** Lets forked fibers run up to their next suspension. */
const tick = Effect.gen(function* () {
  for (let i = 0; i < 20; i++) yield* Effect.yieldNow
})

/** A handler that echoes frames back until the connection ends. */
const echo = (conn: Connection) =>
  conn.frames.pipe(
    Stream.runForEach(conn.send),
    Effect.mapError((cause) => new Links.LinkError({ cause })),
  )

describe('Links', () => {
  it.effect('keeps the connection dialed by the lower endpoint id on both sides', () =>
    Effect.gen(function* () {
      const a = yield* Links.make({ selfId: 'aaaa', handler: echo })
      const b = yield* Links.make({ selfId: 'bbbb', handler: echo })
      // Both dial at once: aaaa→bbbb and bbbb→aaaa.
      const [abAtA, abAtB] = connPair('aaaa', 'bbbb')
      const [baAtB, baAtA] = connPair('bbbb', 'aaaa')
      yield* Effect.forkChild(a.run({ conn: fromFramed(abAtA), outgoing: true }))
      yield* Effect.forkChild(b.run({ conn: fromFramed(baAtB), outgoing: true }))
      yield* tick
      yield* Effect.forkChild(a.run({ conn: fromFramed(baAtA), outgoing: false }))
      yield* Effect.forkChild(b.run({ conn: fromFramed(abAtB), outgoing: false }))
      yield* tick
      expect(abAtA.closed).toBe(false)
      expect(baAtA.closed).toBe(true)
      expect(a.has('bbbb') && b.has('aaaa')).toBe(true)
    }),
  )

  it.effect('a newer connection in the same direction replaces a stale one', () =>
    Effect.gen(function* () {
      const links = yield* Links.make({ selfId: 'aaaa', handler: echo })
      const [old] = connPair('aaaa', 'bbbb')
      const [fresh] = connPair('aaaa', 'bbbb')
      yield* Effect.forkChild(links.run({ conn: fromFramed(old), outgoing: false }))
      yield* tick
      yield* Effect.forkChild(links.run({ conn: fromFramed(fresh), outgoing: false }))
      yield* tick
      expect(old.closed).toBe(true)
      expect(fresh.closed).toBe(false)
      expect(SubscriptionRef.getUnsafe(links.connected)).toEqual(new Set(['bbbb']))
    }),
  )

  it.effect('interrupting the handler fiber closes the connection; awaitGone completes', () =>
    Effect.gen(function* () {
      const links = yield* Links.make({ selfId: 'aaaa', handler: echo })
      const [local] = connPair('aaaa', 'bbbb')
      const fiber = yield* Effect.forkChild(links.run({ conn: fromFramed(local), outgoing: true }))
      yield* tick
      expect(links.has('bbbb')).toBe(true)
      const gone = yield* Effect.forkChild(links.awaitGone('bbbb'))
      yield* tick
      yield* Fiber.interrupt(fiber)
      yield* Fiber.join(gone)
      expect(local.closed).toBe(true)
      expect(links.has('bbbb')).toBe(false)
    }),
  )

  it.effect('the link ends when the remote closes', () =>
    Effect.gen(function* () {
      const links = yield* Links.make({ selfId: 'aaaa', handler: echo })
      const [local, remote] = connPair('aaaa', 'bbbb')
      const fiber = yield* Effect.forkChild(links.run({ conn: fromFramed(local), outgoing: true }))
      yield* tick
      remote.close()
      yield* Fiber.join(fiber)
      expect(links.has('bbbb')).toBe(false)
    }),
  )

  it.effect(
    'an interrupted replacement waits for the old finalizer before a third handler starts',
    () =>
      Effect.gen(function* () {
        const releasing = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const started = yield* Deferred.make<void>()
        const [old] = connPair('aaaa', 'bbbb')
        const [replacement] = connPair('aaaa', 'bbbb')
        const [fresh] = connPair('aaaa', 'bbbb')
        const oldConn = fromFramed(old)
        let oldReleased = false
        const links = yield* Links.make({
          selfId: 'aaaa',
          handler: (conn) =>
            conn === oldConn
              ? Effect.never.pipe(
                  Effect.ensuring(
                    Effect.gen(function* () {
                      yield* Deferred.succeed(releasing, undefined)
                      yield* Deferred.await(release)
                      oldReleased = true
                    }),
                  ),
                )
              : Effect.gen(function* () {
                  expect(oldReleased).toBe(true)
                  yield* Deferred.succeed(started, undefined)
                  return yield* Effect.never
                }),
        })
        yield* Effect.forkChild(links.run({ conn: oldConn, outgoing: true }))
        yield* tick
        const replacing = yield* Effect.forkChild(
          links.run({ conn: fromFramed(replacement), outgoing: true }),
        )
        yield* Deferred.await(releasing)
        const interrupted = yield* Effect.forkChild(Fiber.interrupt(replacing))
        const current = yield* Effect.forkChild(
          links.run({ conn: fromFramed(fresh), outgoing: true }),
        )
        yield* tick
        expect(replacement.closed).toBe(false)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(interrupted)
        yield* Deferred.await(started)
        expect(old.closed).toBe(true)
        expect(replacement.closed).toBe(true)
        expect(fresh.closed).toBe(false)
        expect(links.has('bbbb')).toBe(true)
        yield* Fiber.interrupt(current)
        yield* links.awaitGone('bbbb')
      }),
  )

  it.effect('a failed handler is closed and the same endpoint can reconnect', () =>
    Effect.gen(function* () {
      let attempts = 0
      const started = yield* Deferred.make<void>()
      const links = yield* Links.make({
        selfId: 'aaaa',
        handler: () =>
          ++attempts === 1
            ? Effect.fail(new Links.LinkError({ cause: 'broken handler' }))
            : Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      })
      const [first] = connPair('aaaa', 'bbbb')
      yield* links.run({ conn: fromFramed(first), outgoing: true })
      expect(first.closed).toBe(true)
      expect(links.has('bbbb')).toBe(false)
      const [second] = connPair('aaaa', 'bbbb')
      const run = yield* Effect.forkChild(links.run({ conn: fromFramed(second), outgoing: true }))
      yield* Deferred.await(started)
      expect(links.has('bbbb')).toBe(true)
      yield* Fiber.interrupt(run)
      expect(second.closed).toBe(true)
    }),
  )
})
