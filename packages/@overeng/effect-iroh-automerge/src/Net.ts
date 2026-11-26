import {
  Context,
  Duration,
  Effect,
  Equal,
  Exit,
  Fiber,
  FiberSet,
  Hash,
  Layer,
  RcMap,
  Schedule,
  Scope,
  Stream,
  SubscriptionRef,
  SynchronizedRef,
} from 'effect'

import { IrohNode, type PeerAddress, type StartError } from '@overeng/effect-iroh-browser'

import { IrohNetworkAdapter } from './IrohNetworkAdapter.ts'

/**
 * Device networking as Effect services.
 *
 * - `Net` is cheap and always available (it's in the app runtime). It owns the observable
 *   `status` and starts the iroh node lazily — the wasm is ~5MB — on `start`.
 * - A started node is a *session*: the `IrohNode` layer plus the automerge-repo adapter and
 *   the accept loop, all living in one child scope of `Net`. A failed start closes that scope
 *   (releasing the Web Lock and the endpoint), and the next `start` tries again.
 * - `connect(peer)` holds a reference to a per-peer dial loop (an `RcMap` entry) for as long as
 *   the caller's scope is open. The loop redials with exponential backoff and is woken early
 *   by `Wakeups` (tab visible again, browser online).
 */

/** Observable progress of a retained peer connection. */
export type PeerState = 'connecting' | 'connected' | 'unreachable'

/** Current endpoint lifecycle, peer connectivity and startup failure. */
export interface NetStatus {
  readonly phase: 'off' | 'starting' | 'online' | 'error' | 'other-tab'
  readonly self?: PeerAddress | undefined
  /** State of every peer this tab is trying to reach. */
  readonly peers: ReadonlyMap<string, PeerState>
  /** Why the last start failed (phase `error`); its tag lets apps say what to do next. */
  readonly error?: StartError | undefined
}

/** Where the adapter is plugged in (the app's automerge repo). */
export class RepoNetwork extends Context.Service<
  RepoNetwork,
  { readonly attach: (adapter: IrohNetworkAdapter) => Effect.Effect<void, never, Scope.Scope> }
>()('@overeng/effect-iroh-automerge/RepoNetwork') {}

/** "The network may be back" signals. */
export class Wakeups extends Context.Service<Wakeups, Stream.Stream<void>>()(
  '@overeng/effect-iroh-automerge/Wakeups',
) {
  /** Browser online again, or the tab became visible again. */
  static readonly browser = Layer.sync(Wakeups, () =>
    Stream.merge(
      Stream.fromEventListener(window, 'online'),
      Stream.fromEventListener(document, 'visibilitychange').pipe(
        Stream.filter(() => document.visibilityState === 'visible'),
      ),
    ).pipe(Stream.as(undefined)),
  )
}

/** Live endpoint and adapter owned by one networking session. */
export interface Session {
  readonly endpointId: string
  readonly relay: string
  readonly node: IrohNode['Service']
  readonly adapter: IrohNetworkAdapter
}

/** Lazily started networking with shared, scoped peer dial loops. */
export class Net extends Context.Service<
  Net,
  {
    readonly status: SubscriptionRef.SubscriptionRef<NetStatus>
    /** Starts the node (once; again after a failure) and resolves when it is online. */
    readonly start: Effect.Effect<Session, StartError>
    /**
     * `start` for a device that must stay reachable (a shared session, a dial loop): outlives
     * another tab owning the endpoint and relays that did not answer in time.
     */
    readonly keepOnline: Effect.Effect<Session, StartError>
    /** Keeps a connection to `peer` while the scope is open. */
    readonly connect: (peer: PeerAddress) => Effect.Effect<void, never, Scope.Scope>
  }
>()('@overeng/effect-iroh-automerge/Net') {}

/** Failed dials after which a peer is reported as unreachable (the loop keeps trying). */
export const UNREACHABLE_AFTER = 3

/** Delay before the next dial: 1s, 2s, 4s … capped at 30s. Restarted after every success. */
export const dialBackoff: Schedule.Schedule<Duration.Duration> = Schedule.exponential(
  '1 second',
).pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(30))),
  ),
)

/** RcMap key: one dial loop per endpoint id (the first caller's relay is used). */
class PeerKey implements Equal.Equal {
  readonly peer: PeerAddress
  constructor(peer: PeerAddress) {
    this.peer = peer
  }
  [Equal.symbol](that: unknown) {
    return that instanceof PeerKey && that.peer.endpointId === this.peer.endpointId
  }
  [Hash.symbol]() {
    return Hash.string(this.peer.endpointId)
  }
}

const withPeer = ({
  status,
  adapter,
  endpointId,
  state,
}: {
  status: NetStatus
  adapter: IrohNetworkAdapter | undefined
  endpointId: string
  state: PeerState | undefined
}): NetStatus => {
  // A live connection always wins over what a dial loop believes.
  if (state && adapter?.connectedEndpoints.has(endpointId)) state = 'connected'
  if (status.peers.get(endpointId) === state) return status
  const peers = new Map(status.peers)
  if (state) peers.set(endpointId, state)
  else peers.delete(endpointId)
  return { ...status, peers }
}

/** Mirrors the adapter's live connections into the peer states. */
const withConnected = ({ status, adapter }: { status: NetStatus; adapter: IrohNetworkAdapter }): NetStatus => {
  const connected = adapter.connectedEndpoints
  const peers = new Map(status.peers)
  for (const id of connected) peers.set(id, 'connected')
  for (const [id, state] of peers)
    if (state === 'connected' && !connected.has(id)) peers.set(id, 'connecting')
  return { ...status, peers }
}

/** `Net`, starting its node from `nodeLayer` (the wasm node in the app, a fake in tests). */
export const makeNet = (
  nodeLayer: Layer.Layer<IrohNode, Exclude<StartError, { _tag: 'RelayUnreachable' }>>,
): Layer.Layer<Net, never, RepoNetwork | Wakeups> =>
  Layer.effect(
    Net,
    Effect.gen(function* () {
      const netScope = yield* Effect.scope
      const repoNetwork = yield* RepoNetwork
      const wakeups = yield* Wakeups
      const status = yield* SubscriptionRef.make<NetStatus>({ phase: 'off', peers: new Map() })
      let adapterRef: IrohNetworkAdapter | undefined
      const setPeer = ({ endpointId, state }: { endpointId: string; state: PeerState | undefined }) =>
        SubscriptionRef.update(status, (s) => withPeer({ status: s, adapter: adapterRef, endpointId, state }))

      /** Builds node + adapter + accept loop in `scope`. */
      const openSession = (scope: Scope.Scope) =>
        Effect.gen(function* () {
          const nodeContext = yield* Layer.buildWithScope(nodeLayer, scope)
          const node = Context.get(nodeContext, IrohNode)
          const adapter = new IrohNetworkAdapter(node.endpointId)
          yield* repoNetwork.attach(adapter)
          // Every accepted connection runs in its own fiber; closing the session interrupts them.
          const connections = yield* FiberSet.make<void>()
          yield* node.incoming.pipe(
            Stream.runForEach((conn) =>
              FiberSet.run(connections, adapter.runConnection({ conn, outgoing: false })),
            ),
            Effect.forkScoped,
          )
          adapterRef = adapter
          yield* adapter.changes.pipe(
            Stream.runForEach(() =>
              SubscriptionRef.update(status, (s) => withConnected({ status: s, adapter })),
            ),
            Effect.forkScoped,
          )
          const relay = yield* node.homeRelay
          return { endpointId: node.endpointId, relay, node, adapter } satisfies Session
        }).pipe(Scope.provide(scope))

      const startOnce = Effect.gen(function* () {
        // A tab that syncs through another tab keeps saying so while it re-checks the lock.
        yield* SubscriptionRef.update(status, (s): NetStatus =>
          s.phase === 'other-tab' ? s : { ...s, phase: 'starting', error: undefined },
        )
        const scope = yield* Scope.fork(netScope)
        const exit = yield* Effect.exit(openSession(scope))
        if (Exit.isFailure(exit)) {
          adapterRef = undefined
          yield* Scope.close(scope, exit)
          return yield* exit
        }
        const session = exit.value
        yield* SubscriptionRef.update(status, (s): NetStatus => ({
          ...s,
          phase: 'online',
          self: { endpointId: session.endpointId, relay: session.relay },
        }))
        return session
      }).pipe(
        Effect.tapError((error) =>
          SubscriptionRef.update(status, (s): NetStatus =>
            // Not a failure: another tab of this browser owns the device's endpoint and this
            // tab syncs through it (BroadcastChannel).
            error._tag === 'NotLeader'
              ? { ...s, phase: 'other-tab', error: undefined }
              : { ...s, phase: 'error', error },
          ),
        ),
      )

      // The in-flight or finished start. Runs in the Net scope, so callers that give up
      // waiting (interruption) don't abort it for everyone else.
      const current = yield* SynchronizedRef.make<Fiber.Fiber<Session, StartError> | undefined>(
        undefined,
      )
      const start: Effect.Effect<Session, StartError> = SynchronizedRef.modifyEffect(
        current,
        (fiber) =>
          fiber
            ? Effect.succeed([fiber, fiber] as const)
            : startOnce.pipe(
                // Forget a failed start so the next caller retries.
                Effect.tapError(() => SynchronizedRef.set(current, undefined)),
                Effect.forkIn(netScope),
                Effect.map((fiber) => [fiber, fiber] as const),
              ),
      ).pipe(Effect.flatMap(Fiber.join))

      /** Sleeps for `delay`, or less if the network may be back. */
      const sleepOrWake = (delay: Duration.Duration) =>
        Stream.runHead(wakeups).pipe(
          Effect.asVoid,
          Effect.timeoutOrElse({ duration: delay, orElse: () => Effect.void }),
        )

      /**
       * `start` that outlives start failures that clear up by themselves:
       * - another tab owns the endpoint: a follower re-checks ownership every second while a
       *   consumer holds this connection (Web Lock probes are local and cheap);
       * - no relay answered in time (slow or flaky network, relay hiccup): retried with
       *   `dialBackoff`, early when the network may be back. Without this, one slow relay
       *   handshake left a device offline until someone reloaded.
       * Other failures (no Ed25519, wasm load, spawn) end it; `status` reports them.
       */
      const keepOnline = Effect.gen(function* () {
        const backoff = yield* Schedule.toStep(dialBackoff)
        for (;;) {
          const session = yield* start.pipe(
            Effect.retry({
              schedule: Schedule.spaced('1 second'),
              while: (error) => error._tag === 'NotLeader',
            }),
            Effect.catchTag('RelayUnreachable', () => Effect.void),
          )
          if (session) return session
          const [, delay] = yield* Effect.clockWith((clock) =>
            backoff(clock.currentTimeMillisUnsafe(), undefined),
          ).pipe(Effect.orDie)
          yield* sleepOrWake(delay)
        }
      })

      const dialLoop = (peer: PeerAddress) =>
        Effect.gen(function* () {
          // Releasing the holder cancels the start retries too.
          const session = yield* keepOnline
          if (peer.endpointId === session.endpointId) return
          const { node, adapter } = session
          yield* setPeer({ endpointId: peer.endpointId, state: 'connecting' })
          let failures = 0
          let backoff = yield* Schedule.toStep(dialBackoff)
          const nextDelay = Effect.clockWith((clock) =>
            backoff(clock.currentTimeMillisUnsafe(), undefined),
          )
          for (;;) {
            if (adapter.hasLink(peer.endpointId)) {
              // Already connected (possibly they dialed us). Wait until that link is gone.
              yield* adapter.awaitNoLink(peer.endpointId)
              failures = 0
              backoff = yield* Schedule.toStep(dialBackoff)
              continue
            }
            const dialed = yield* node.dial(peer).pipe(
              Effect.flatMap((conn) =>
                // Count the dial as a success before the (long-running) connection.
                Effect.sync(() => {
                  failures = 0
                }).pipe(Effect.andThen(adapter.runConnection({ conn, outgoing: true }))),
              ),
              Effect.scoped,
              Effect.exit,
            )
            if (Exit.isSuccess(dialed)) {
              backoff = yield* Schedule.toStep(dialBackoff)
            } else {
              failures++
              if (failures >= UNREACHABLE_AFTER) yield* setPeer({ endpointId: peer.endpointId, state: 'unreachable' })
              yield* Effect.logWarning('[iroh] dial failed', dialed.cause)
            }
            const [, delay] = yield* nextDelay.pipe(Effect.orDie)
            yield* sleepOrWake(delay)
          }
        }).pipe(
          // Other startup failures are reported in status and retried by an explicit start.
          Effect.ignore,
          Effect.ensuring(setPeer({ endpointId: peer.endpointId, state: undefined })),
        )

      const loops = yield* RcMap.make({
        lookup: (key: PeerKey) => Effect.forkScoped(dialLoop(key.peer)),
      })

      return Net.of({
        status,
        start,
        keepOnline,
        connect: (peer) => RcMap.get(loops, new PeerKey(peer)).pipe(Effect.asVoid),
      })
    }),
  )