import { Context, type Duration, Effect, Layer, type Scope, Stream } from 'effect'

import type { FramedConn } from './Connection.ts'
import {
  DialError,
  NoEd25519,
  type NotLeader,
  RelayUnreachable,
  SpawnError,
  WasmLoadError,
} from './errors.ts'
import { exclusiveLock } from './WebLock.ts'

/** Endpoint identity and relay URL used to dial a peer. */
export interface PeerAddress {
  readonly endpointId: string
  readonly relay: string
}

/**
 * n0's public relays, written WITHOUT the trailing dot iroh's built-in defaults carry
 * ("euc1-1.relay.n0.iroh.link."): browsers can't open TLS/WebSocket connections to such
 * fully-qualified names, so the endpoint would never come online (seen on iOS Safari and
 * Chromium). The endpoint picks the closest one as its home relay.
 */
export const N0_RELAYS: ReadonlyArray<string> = [
  'https://euc1-1.relay.n0.iroh.link',
  'https://use1-1.relay.n0.iroh.link',
  'https://usw1-1.relay.n0.iroh.link',
  'https://aps1-1.relay.n0.iroh.link',
]

/**
 * An iroh endpoint. Only exists while the layer's scope is open: building it claims the
 * identity (Web Lock), loads the wasm and binds the endpoint; closing the scope closes the
 * endpoint and releases the lock.
 */
export class IrohNode extends Context.Service<
  IrohNode,
  {
    readonly endpointId: string
    /** The relay this endpoint can be reached through. */
    readonly homeRelay: Effect.Effect<string, RelayUnreachable>
    /** Incoming connections, until the endpoint closes. */
    readonly incoming: Stream.Stream<FramedConn>
    /** Dials a peer. The connection is closed when the surrounding scope closes. */
    readonly dial: (peer: PeerAddress) => Effect.Effect<FramedConn, DialError, Scope.Scope>
  }
>()('@overeng/effect-iroh-browser/IrohNode') {}

/** Structural type of the iroh wasm bindings (`iroh-wasm` crate, built with wasm-bindgen). */
export interface IrohWasmNode {
  endpointId(): string
  homeRelay(): Promise<unknown>
  accept(): Promise<unknown>
  connect(endpointId: string, relayUrl: string): Promise<unknown>
  close(): Promise<unknown>
}
/** Lazy wasm-bindgen initialization and endpoint factory. */
export interface IrohWasmModule {
  default(): Promise<unknown>
  spawnNode(relayUrl?: string | null, secretKey?: Uint8Array | null): Promise<IrohWasmNode>
}

/** Identity, relay and ownership settings for the browser endpoint. */
export interface WasmNodeOptions {
  /** Imports the wasm-bindgen module (dynamic import, so the ~5MB wasm loads lazily). */
  readonly load: () => Promise<IrohWasmModule>
  /** 32-byte Ed25519 secret key; the endpoint id is its public key. */
  readonly secretKey: Uint8Array | undefined
  /** Relays to use (the closest becomes the home relay). Default: `N0_RELAYS`. */
  readonly relays?: ReadonlyArray<string> | undefined
  /** How long the endpoint may take to reach a relay before `homeRelay` fails. Default 25s. */
  readonly homeRelayTimeout?: Duration.Input | undefined
  /** Web Lock that makes this tab the only one running the endpoint for this key. */
  readonly lockName?: string | undefined
}

/** Failures while acquiring ownership and constructing a wasm endpoint. */
export type NodeBuildError = NotLeader | NoEd25519 | WasmLoadError | SpawnError

/** The real node over the iroh wasm bindings. Nothing is fetched until the layer is built. */
export const layerWasm = (options: WasmNodeOptions): Layer.Layer<IrohNode, NodeBuildError> =>
  Layer.effect(
    IrohNode,
    Effect.gen(function* () {
      // Only one tab per key can be this endpoint on the network.
      if (options.lockName) yield* exclusiveLock(options.lockName)
      const secretKey = options.secretKey
      if (!secretKey) return yield* new NoEd25519()
      const wasm = yield* Effect.tryPromise({
        try: async () => {
          const module = await options.load()
          await module.default()
          return module
        },
        catch: (cause) => new WasmLoadError(cause),
      })
      const node = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => wasm.spawnNode((options.relays ?? N0_RELAYS).join(','), secretKey),
          catch: (cause) => new SpawnError(cause),
        }),
        (node) => Effect.promise(() => node.close().catch(() => {})),
      )
      const endpointId = node.endpointId()

      return IrohNode.of({
        endpointId,
        // Typed failure (never a defect), and bounded: a rejected or hanging relay connection
        // must surface as an error instead of an endless "connecting".
        homeRelay: Effect.tryPromise({
          try: () => node.homeRelay() as Promise<string | null>,
          catch: () => new RelayUnreachable(),
        }).pipe(
          Effect.filterOrFail(
            (relay): relay is string => !!relay,
            () => new RelayUnreachable(),
          ),
          Effect.timeoutOrElse({
            duration: options.homeRelayTimeout ?? '25 seconds',
            orElse: () => Effect.fail(new RelayUnreachable()),
          }),
        ),
        incoming: Stream.fromEffectRepeat(
          Effect.tryPromise(() => node.accept() as Promise<FramedConn | null>),
        ).pipe(
          Stream.takeWhile((conn): conn is FramedConn => conn !== null && conn !== undefined),
          Stream.catchCause((cause) =>
            Stream.fromEffect(Effect.logWarning('[iroh] accept failed', cause)).pipe(Stream.drain),
          ),
        ),
        dial: (peer) =>
          Effect.acquireRelease(
            Effect.tryPromise({
              try: () => node.connect(peer.endpointId, peer.relay) as Promise<FramedConn>,
              catch: (cause) => new DialError({ endpointId: peer.endpointId, cause }),
            }),
            (conn) => Effect.sync(() => conn.close()),
          ),
      })
    }),
  )
