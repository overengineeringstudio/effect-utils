import { Effect, Stream } from 'effect'

import { ConnectionError } from './errors.ts'

/** Structural type of the wasm `IrohConn` (a u32-length-framed bidirectional stream). */
export interface FramedConn {
  remoteId(): string
  send(data: Uint8Array): Promise<void>
  /** Next frame, or null once the remote closed its side. */
  recv(): Promise<Uint8Array | null>
  close(): void
}

/** A framed connection to one remote endpoint, as Effects. */
export interface Connection {
  /** The remote's endpoint id, proven by the encrypted handshake. */
  readonly remoteId: string
  readonly send: (frame: Uint8Array) => Effect.Effect<void, ConnectionError>
  /** Incoming frames; ends when the remote closes. Consume it once. */
  readonly frames: Stream.Stream<Uint8Array, ConnectionError>
  readonly close: Effect.Effect<void>
}

/** Adapts the wasm connection into typed send effects and a single-consumer frame stream. */
export const fromFramed = (conn: FramedConn): Connection => ({
  remoteId: conn.remoteId(),
  send: (frame) =>
    Effect.tryPromise({
      try: () => conn.send(frame),
      catch: (cause) => new ConnectionError(cause),
    }),
  frames: Stream.fromEffectRepeat(
    Effect.tryPromise({ try: () => conn.recv(), catch: (cause) => new ConnectionError(cause) }),
  ).pipe(Stream.takeWhile((frame): frame is Uint8Array => frame !== null)),
  close: Effect.sync(() => conn.close()),
})
