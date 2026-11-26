import { cbor, type PeerId } from '@automerge/automerge-repo'
import {
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  PubSub,
  Queue,
  References,
  Schedule,
  Scope,
  Stream,
  SubscriptionRef,
} from 'effect'
import { TestClock } from 'effect/testing'
import { describe, expect, it } from 'vitest'

import {
  DialError,
  NotLeader,
  RelayUnreachable,
  IrohNode,
  type FramedConn,
  type PeerAddress,
} from '@overeng/effect-iroh-browser'
import { connPair, type FakeConn } from '@overeng/effect-iroh-browser/testing'

import { dialBackoff, makeNet, Net, RepoNetwork, UNREACHABLE_AFTER, Wakeups } from './Net.ts'

const SELF = 'aaaa'
const PEER: PeerAddress = { endpointId: 'bbbb', relay: 'https://relay.test' }

interface Harness {
  readonly net: Net['Service']
  /** Clock time (ms) of every dial. */
  readonly dials: number[]
  readonly builds: { count: number }
  readonly wake: Effect.Effect<void>
  readonly incoming: Queue.Queue<FramedConn>
}

/**
 * Runs `test` against a `Net` whose node is fake: dials fail unless `answer` returns a
 * connection, and time is a TestClock.
 */
const withNet = <TResult>({
  test,
  options = {},
}: {
  test: (h: Harness) => Effect.Effect<TResult, unknown>
  options?: {
    answer?: (attempt: number) => FakeConn | undefined
    nodeFails?: (build: number) => boolean
    /** Builds whose endpoint never reaches a relay. */
    relayFails?: (build: number) => boolean
  }
}) =>
  Effect.gen(function* () {
    const dials: number[] = []
    const builds = { count: 0 }
    const incoming = yield* Queue.unbounded<FramedConn>()
    const wakes = yield* PubSub.unbounded<void>()
    const fakeNode = Layer.effect(
      IrohNode,
      Effect.gen(function* () {
        builds.count++
        const build = builds.count
        if (options.nodeFails?.(build)) return yield* new NotLeader()
        return IrohNode.of({
          endpointId: SELF,
          homeRelay: options.relayFails?.(build)
            ? Effect.fail(new RelayUnreachable())
            : Effect.succeed('https://relay.test'),
          incoming: Stream.fromQueue(incoming),
          dial: (peer) =>
            Effect.clockWith((clock) => {
              dials.push(clock.currentTimeMillisUnsafe())
              const conn = options.answer?.(dials.length)
              return conn
                ? Effect.succeed(conn)
                : Effect.fail(new DialError({ endpointId: peer.endpointId, cause: 'offline' }))
            }),
        })
      }),
    )
    const layer = makeNet(fakeNode).pipe(
      Layer.provide([
        Layer.succeed(RepoNetwork, { attach: () => Effect.void }),
        Layer.succeed(Wakeups, Stream.fromPubSub(wakes)),
      ]),
    )
    const net = Context.get(yield* Layer.build(layer), Net)
    return yield* test({
      net,
      dials,
      builds,
      incoming,
      wake: PubSub.publish(wakes, undefined).pipe(Effect.asVoid),
    })
  }).pipe(
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.provideService(References.MinimumLogLevel, 'None'),
    Effect.runPromise,
  )

const peerState = (net: Net['Service']) =>
  SubscriptionRef.get(net.status).pipe(Effect.map((s) => s.peers.get(PEER.endpointId)))

/** Lets forked fibers run up to their next sleep. */
const tick = Effect.gen(function* () {
  for (let i = 0; i < 20; i++) yield* Effect.yieldNow
})
const advance = (d: Duration.Input) => TestClock.adjust(d).pipe(Effect.andThen(tick))

describe('dialBackoff', () => {
  it('doubles from 1s and caps at 30s', async () => {
    const delays = await Effect.runPromise(
      Effect.gen(function* () {
        const step = yield* Schedule.toStep(dialBackoff)
        const out: number[] = []
        for (let i = 0; i < 8; i++) out.push(Duration.toMillis((yield* step(0, undefined))[1]))
        return out
      }),
    )
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
  })
})

describe('Net', () => {
  it('builds synchronously, so React can read its status on first render', async () => {
    const runtime = ManagedRuntime.make(
      makeNet(Layer.effect(IrohNode, Effect.die('not started'))).pipe(
        Layer.provide([
          Layer.succeed(RepoNetwork, { attach: () => Effect.void }),
          Layer.succeed(Wakeups, Stream.never),
        ]),
      ),
    )
    const net = runtime.runSync(Net.useSync((net) => net))
    expect(SubscriptionRef.getUnsafe(net.status).phase).toBe('off')
    await runtime.dispose()
  })

  it('starts once and reports the node online', () =>
    withNet({
      test: ({ net, builds }) =>
        Effect.gen(function* () {
          expect((yield* SubscriptionRef.get(net.status)).phase).toBe('off')
          const [s1, s2] = yield* Effect.all([net.start, net.start], { concurrency: 'unbounded' })
          expect(s1).toBe(s2)
          expect(builds.count).toBe(1)
          const status = yield* SubscriptionRef.get(net.status)
          expect(status.phase).toBe('online')
          expect(status.self).toEqual({ endpointId: SELF, relay: 'https://relay.test' })
        }),
    }))

  it('reports a failed start and retries on the next start', () =>
    withNet({
      test: ({ net, builds }) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(net.start)
          expect(error._tag).toBe('NotLeader')
          const status = yield* SubscriptionRef.get(net.status)
          // Not an error: this tab syncs through the tab that owns the device's endpoint.
          expect(status).toMatchObject({ phase: 'other-tab', error: undefined })
          yield* net.start
          expect(builds.count).toBe(2)
          expect((yield* SubscriptionRef.get(net.status)).phase).toBe('online')
        }),
      options: { nodeFails: (build) => build === 1 },
    }))

  it('keeps a dial loop starting after the relay was out of reach', () => {
    let relayDown = true
    return withNet({
      test: ({ net, builds, dials, wake }) =>
        Effect.gen(function* () {
          yield* Effect.forkChild(Effect.scoped(Effect.andThen(net.connect(PEER), Effect.never)))
          yield* tick
          expect(yield* SubscriptionRef.get(net.status)).toMatchObject({
            phase: 'error',
            error: { _tag: 'RelayUnreachable' },
          })
          expect(builds.count).toBe(1)
          // Retried with the dial backoff, without anyone pressing "try again".
          yield* advance('1 second')
          expect(builds.count).toBe(2)
          // The network may be back: try again right away.
          relayDown = false
          yield* wake
          yield* tick
          expect(builds.count).toBe(3)
          expect((yield* SubscriptionRef.get(net.status)).phase).toBe('online')
          expect(dials).toEqual([1000])
        }),
      options: { relayFails: () => relayDown },
    })
  })

  it('keeps a shared session online without peers after the relay was out of reach', () => {
    let relayDown = true
    return withNet({
      test: ({ net, builds }) =>
        Effect.gen(function* () {
          yield* Effect.forkChild(net.keepOnline)
          yield* tick
          expect((yield* SubscriptionRef.get(net.status)).phase).toBe('error')
          relayDown = false
          yield* advance('1 second')
          expect(builds.count).toBe(2)
          expect((yield* SubscriptionRef.get(net.status)).phase).toBe('online')
        }),
      options: { relayFails: () => relayDown },
    })
  })

  it('stops follower probes with the holder and takes over when the owner leaves', () => {
    let ownerHolds = true
    return withNet({
      test: ({ net, builds, dials }) =>
        Effect.gen(function* () {
          const first = yield* Scope.make()
          yield* net.connect(PEER).pipe(Scope.provide(first))
          yield* tick
          expect((yield* SubscriptionRef.get(net.status)).phase).toBe('other-tab')
          expect(builds.count).toBe(1)
          yield* Scope.close(first, Exit.void)
          yield* advance('2 seconds')
          expect(builds.count).toBe(1)
          const second = yield* Scope.make()
          yield* net.connect(PEER).pipe(Scope.provide(second))
          yield* tick
          expect(builds.count).toBe(2)
          ownerHolds = false
          yield* advance('1 second')
          expect((yield* SubscriptionRef.get(net.status)).phase).toBe('online')
          expect(builds.count).toBe(3)
          expect(dials).toEqual([3000])
          yield* Scope.close(second, Exit.void)
        }),
      options: { nodeFails: () => ownerHolds },
    })
  })

  it('redials with exponential backoff and reports unreachable after repeated failures', () =>
    withNet({
      test: ({ net, dials }) =>
        Effect.gen(function* () {
          const scope = yield* Scope.make()
          yield* net.connect(PEER).pipe(Scope.provide(scope))
          yield* tick
          expect(dials).toEqual([0])
          expect(yield* peerState(net)).toBe('connecting')
          yield* advance('1 second')
          expect(dials).toEqual([0, 1000])
          expect(yield* peerState(net)).toBe('connecting')
          yield* advance('2 seconds')
          expect(dials).toHaveLength(UNREACHABLE_AFTER)
          expect(yield* peerState(net)).toBe('unreachable')
          yield* advance('4 seconds')
          yield* advance('8 seconds')
          yield* advance('16 seconds')
          yield* advance('30 seconds')
          yield* advance('30 seconds')
          expect(dials).toEqual([0, 1000, 3000, 7000, 15000, 31000, 61000, 91000])
  
          // Releasing the last holder stops the loop and forgets the peer.
          yield* Scope.close(scope, Exit.void)
          yield* tick
          expect(yield* peerState(net)).toBeUndefined()
          yield* advance('1 minute')
          expect(dials).toHaveLength(8)
        }),
    }))

  it('redials immediately when the network may be back', () =>
    withNet({
      test: ({ net, dials, wake }) =>
        Effect.gen(function* () {
          yield* Effect.forkChild(Effect.scoped(Effect.andThen(net.connect(PEER), Effect.never)))
          yield* tick
          yield* advance('1 second')
          yield* advance('2 seconds')
          expect(dials).toEqual([0, 1000, 3000])
          yield* wake
          yield* tick
          expect(dials).toEqual([0, 1000, 3000, 3000])
        }),
    }))

  it('shares one dial loop between holders (ref-counted)', () =>
    withNet({
      test: ({ net, dials }) =>
        Effect.gen(function* () {
          const first = yield* Scope.make()
          const second = yield* Scope.make()
          yield* net.connect(PEER).pipe(Scope.provide(first))
          yield* net.connect(PEER).pipe(Scope.provide(second))
          yield* tick
          expect(dials).toEqual([0])
          yield* Scope.close(first, Exit.void)
          yield* advance('1 second')
          expect(dials).toEqual([0, 1000])
          yield* Scope.close(second, Exit.void)
          yield* advance('1 minute')
          expect(dials).toEqual([0, 1000])
        }),
    }))

  it('restarts the backoff after a successful connection and tracks the live connection', () => {
    let remote: FakeConn | undefined
    return withNet({
      test: ({ net, dials }) =>
        Effect.gen(function* () {
          yield* Effect.forkChild(Effect.scoped(Effect.andThen(net.connect(PEER), Effect.never)))
          yield* tick
          yield* advance('1 second')
          yield* advance('2 seconds')
          expect(dials).toEqual([0, 1000, 3000]) // third dial succeeds
          // Handshake from the remote device; the repo side of this adapter isn't connected,
          // so only the remote hello matters for the status.
          const session = yield* net.start
          session.adapter.connect(`${SELF}-tab` as PeerId)
          yield* Effect.promise(() =>
            remote!.send(
              cbor.encode({
                type: 'games-hello',
                v: 1,
                senderId: `${PEER.endpointId}-t`,
                peerMetadata: {},
              }),
            ),
          )
          yield* tick
          expect(yield* peerState(net)).toBe('connected')

          // The connection drops after a while: dial again after 1s (not 4s), then 2s, …
          yield* advance('10 minutes')
          expect(dials).toHaveLength(3)
          remote!.close()
          yield* tick
          expect(yield* peerState(net)).toBe('connecting')
          yield* advance('1 second')
          expect(dials.at(-1)! - dials.at(-2)!).toBe(600_000 + 1000)
          yield* advance('2 seconds')
          expect(dials).toHaveLength(5)
        }),
      options: {
        answer: (attempt) => {
          if (attempt !== 3) return undefined
          const [local, other] = connPair({ a: SELF, b: PEER.endpointId })
          remote = other
          return local
        },
      },
    })
  })

  it('accepts incoming connections', () =>
    withNet({
      test: ({ net, incoming }) =>
        Effect.gen(function* () {
          const session = yield* net.start
          const [local] = connPair({ a: SELF, b: PEER.endpointId })
          yield* Queue.offer(incoming, local)
          yield* tick
          expect(session.adapter.hasLink(PEER.endpointId)).toBe(true)
        }),
    }))
})