import {
  NetworkAdapter,
  cbor,
  type Message,
  type PeerId,
  type PeerMetadata,
} from '@automerge/automerge-repo'
import { Cause, Effect, Queue, Stream } from 'effect'

import {
  ConnectionError,
  fromFramed,
  Links,
  type Connection,
  type FramedConn,
} from '@overeng/effect-iroh-browser'

/** Historical handshake discriminator and version, retained for deployed-peer compatibility. */
interface Hello {
  type: 'games-hello'
  v: 1
  senderId: PeerId
  peerMetadata: PeerMetadata
}

const isHello = (msg: unknown): msg is Hello =>
  typeof msg === 'object' && msg !== null && (msg as { type?: unknown }).type === 'games-hello'

/** Repo PeerIds are `<deviceId>-<tab>`; the device id is the device's iroh endpoint id. */
export const deviceIdOfPeer = (peerId: string) => peerId.split('-')[0]!

/** PeerIds currently connected over iroh (remote devices), as opposed to local tabs. */
export const remotePeers = new Set<PeerId>()

interface Link {
  conn: Connection
  endpointId: string
  peerId: PeerId | undefined
}

/**
 * Automerge-repo network adapter over framed iroh connections.
 *
 * - Exactly one connection per remote endpoint. If both sides dial at once, both keep the
 *   connection dialed by the lower endpoint id, so they agree without coordination.
 * - The remote's identity comes from the iroh handshake (endpoint id). A repo PeerId is bound
 *   to one endpoint; inbound messages are stamped with that PeerId so peers can't impersonate.
 * - Replacing a connection reports the old peer as disconnected first, so sync state resets.
 *
 * The class shape is dictated by automerge-repo; connections themselves are run as Effects
 * (`runConnection`) whose interruption closes the connection.
 */
export class IrohNetworkAdapter extends NetworkAdapter {
  #links = new Map<string, Link>() // by endpoint id
  #byPeer = new Map<PeerId, Link>()
  #ready = false
  #readyWaiters: Array<() => void> = []
  #listeners = new Set<() => void>()
  readonly #registry: Links.Links

  readonly selfEndpointId: string

  constructor(selfEndpointId: string) {
    super()
    this.selfEndpointId = selfEndpointId
    this.#registry = Effect.runSync(
      Links.make({
        selfId: selfEndpointId,
        handler: (conn) =>
          this.#runPeer(conn).pipe(Effect.mapError((cause) => new Links.LinkError({ cause }))),
      }),
    )
  }

  isReady() {
    return this.#ready
  }

  whenReady() {
    return this.#ready === true
      ? Promise.resolve()
      : new Promise<void>((resolve) => this.#readyWaiters.push(resolve))
  }

  /** Retains automerge-repo's positional connection hook. */
  connect(...args: Parameters<NetworkAdapter['connect']>) {
    const [peerId, peerMetadata] = args
    this.peerId = peerId
    this.peerMetadata = peerMetadata ?? {}
    this.#ready = true
    this.#readyWaiters.splice(0).forEach((resolve) => resolve())
  }

  send(message: Message) {
    const link = this.#byPeer.get(message.targetId)
    if (link === undefined) return
    Effect.runPromise(link.conn.send(cbor.encode(message))).catch((error) => {
      console.warn('[iroh] send failed', error)
      // Repo has already marked this sync message in flight. Keeping a read-open,
      // write-broken link would strand it; reconnect through Net to reset sync state.
      this.#drop(link)
    })
  }

  disconnect() {
    // Drop callbacks notify subscribers, which may mutate the live registry.
    for (const link of Array.from(this.#links.values())) this.#drop(link)
  }

  /** Endpoint ids with a live, handshaken connection. */
  get connectedEndpoints(): ReadonlySet<string> {
    return new Set([...this.#links.values()].filter((l) => l.peerId).map((l) => l.endpointId))
  }

  hasLink(endpointId: string) {
    return this.#registry.has(endpointId)
  }

  subscribe(listener: () => void) {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  /**
   * Emits once on subscription and after every change to the set of links. Intermediate
   * changes may be coalesced: consumers re-read the adapter state.
   */
  get changes(): Stream.Stream<void> {
    return Stream.callback<void>(
      (queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            Queue.offerUnsafe(queue, undefined)
            return this.subscribe(() => void Queue.offerUnsafe(queue, undefined))
          }),
          (unsubscribe) => Effect.sync(unsubscribe),
        ),
      { bufferSize: 1, strategy: 'sliding' },
    )
  }

  /** Completes once there is no link to `endpointId` (immediately if there is none). */
  awaitNoLink(endpointId: string): Effect.Effect<void> {
    return this.changes.pipe(
      Stream.filter(() => !this.hasLink(endpointId)),
      Stream.runHead,
      Effect.asVoid,
    )
  }

  #notify() {
    for (const listener of this.#listeners) listener()
  }

  #drop(link: Link) {
    if (this.#links.get(link.endpointId) === link) this.#links.delete(link.endpointId)
    if (link.peerId !== undefined && link.peerId !== '' && this.#byPeer.get(link.peerId) === link) {
      this.#byPeer.delete(link.peerId)
      remotePeers.delete(link.peerId)
      this.emit('peer-disconnected', { peerId: link.peerId })
    }
    Effect.runSync(link.conn.close)
    this.#notify()
  }

  /** Handles one decoded frame. Returns false if the connection must be dropped. */
  #receive({ link, msg }: { link: Link; msg: unknown }): boolean {
    if (isHello(msg) === true) {
      if (link.peerId !== undefined && link.peerId !== '') return true
      // The peer must speak for the device its encrypted connection proves it is.
      if (deviceIdOfPeer(msg.senderId) !== link.endpointId) return false
      const bound = this.#byPeer.get(msg.senderId)
      // A PeerId stays bound to the endpoint that first claimed it while that link lives.
      if (bound !== undefined && bound !== link && bound.endpointId !== link.endpointId) return false
      if (bound !== undefined) this.#drop(bound)
      link.peerId = msg.senderId
      this.#byPeer.set(msg.senderId, link)
      remotePeers.add(msg.senderId)
      this.emit('peer-candidate', { peerId: msg.senderId, peerMetadata: msg.peerMetadata })
      this.#notify()
      return true
    }
    if (link.peerId === undefined || link.peerId === '') return true
    const repoMsg = msg as Message
    if (repoMsg.targetId !== this.peerId) return true
    this.emit('message', { ...repoMsg, senderId: link.peerId })
    return true
  }

  /**
   * Runs the connection until it closes (or loses the tie-break against another connection to
   * the same endpoint). Never fails; interrupting it drops the link and closes the connection.
   */
  runConnection({ conn, outgoing }: { conn: FramedConn; outgoing: boolean }): Effect.Effect<void> {
    return this.#registry
      .run({ conn: fromFramed(conn), outgoing })
      .pipe(Effect.ensuring(Effect.sync(() => this.#notify())))
  }

  #runPeer(conn: Connection): Effect.Effect<void, ConnectionError> {
    return Effect.suspend(() => {
      const link: Link = { conn, endpointId: conn.remoteId, peerId: undefined }
      this.#links.set(link.endpointId, link)
      this.#notify()
      return Effect.gen({ self: this }, function* () {
        yield* Effect.promise(() => this.whenReady())
        const hello: Hello = {
          type: 'games-hello',
          v: 1,
          senderId: this.peerId!,
          peerMetadata: this.peerMetadata ?? {},
        }
        yield* conn.send(cbor.encode(hello))
        yield* conn.frames.pipe(
          Stream.runForEachWhile((data) =>
            Effect.try({
              try: () => this.#receive({ link, msg: cbor.decode(data) as unknown }),
              catch: (cause) => new ConnectionError(cause),
            }),
          ),
        )
      }).pipe(
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause) === true
            ? Effect.void
            : Effect.logWarning('[iroh] connection error', Cause.squash(cause)),
        ),
        Effect.ensuring(Effect.sync(() => this.#drop(link))),
      )
    })
  }

  /** Promise flavour of `runConnection`. Resolves when the remote is gone. */
  addConnection(options: { conn: FramedConn; outgoing: boolean }): Promise<void> {
    return Effect.runPromise(this.runConnection(options))
  }
}
