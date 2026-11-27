import { Effect, Fiber, Layer, Queue, Stream, SubscriptionRef } from 'effect'
import { describe, expect, it } from 'vitest'

import type { PeerAddress } from '@overeng/effect-iroh-browser'

import { mesh } from './mesh.ts'
import { Net, type NetStatus, type Session } from './Net.ts'

const peer = (id: string): PeerAddress => ({ endpointId: id, relay: 'https://relay.test' })

/** A `Net` that records `keepOnline` calls and which peers are held right now. */
const fakeNet = Effect.gen(function* () {
  const held = new Map<string, number>()
  const online = { count: 0 }
  const status = yield* SubscriptionRef.make<NetStatus>({ phase: 'off', peers: new Map() })
  const service = Net.of({
    status,
    start: Effect.die('unused'),
    keepOnline: Effect.sync(() => {
      online.count++
    }).pipe(Effect.andThen(Effect.never as Effect.Effect<Session>)),
    connect: (p) =>
      Effect.acquireRelease(
        Effect.sync(() => held.set(p.endpointId, (held.get(p.endpointId) ?? 0) + 1)),
        () =>
          Effect.sync(() => {
            const n = (held.get(p.endpointId) ?? 1) - 1
            if (n === 0) held.delete(p.endpointId)
            else held.set(p.endpointId, n)
          }),
      ).pipe(Effect.asVoid),
  })
  return { held, online, layer: Layer.succeed(Net, service) }
})

const settle = Effect.sleep('10 millis')

describe('mesh', () => {
  it('stays offline until a set arrives, then follows the latest set', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const net = yield* fakeNet
        const sets = yield* Queue.unbounded<ReadonlyArray<PeerAddress> | undefined>()
        const fiber = yield* mesh(Stream.fromQueue(sets)).pipe(
          Effect.provide(net.layer),
          Effect.forkChild,
        )

        yield* Queue.offer(sets, undefined)
        yield* settle
        expect(net.online.count).toBe(0)
        expect([...net.held.keys()]).toEqual([])

        // An empty set already brings the node online: peers may dial in.
        yield* Queue.offer(sets, [])
        yield* settle
        expect(net.online.count).toBe(1)

        yield* Queue.offer(sets, [peer('b'), peer('c')])
        yield* settle
        expect([...net.held.keys()].sort()).toEqual(['b', 'c'])

        yield* Queue.offer(sets, [peer('c')])
        yield* settle
        expect([...net.held.keys()]).toEqual(['c'])
        expect(net.online.count).toBe(1)

        yield* Fiber.interrupt(fiber)
        expect([...net.held.keys()]).toEqual([])
      }),
    ))
})
