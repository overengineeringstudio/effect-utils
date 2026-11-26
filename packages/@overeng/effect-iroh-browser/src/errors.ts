import { Data } from 'effect'

/**
 * Typed failures of the networking layer. Every error carries the user-facing `message`
 * that ends up in `NetStatus.error` (the messages are the ones the app showed before).
 */

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/** Another tab of this browser owns the device's persistent iroh identity (Web Lock). */
export class NotLeader extends Data.TaggedError('NotLeader')<{ readonly message: string }> {
  constructor() {
    super({ message: 'networking runs in another tab of this browser' })
  }
}

/** WebCrypto lacks Ed25519, so there is no device key to run iroh with. */
export class NoEd25519 extends Data.TaggedError('NoEd25519')<{ readonly message: string }> {
  constructor() {
    super({ message: 'this browser cannot create a device key (Ed25519)' })
  }
}

/** Loading the iroh wasm module failed (offline before it was cached, …). */
export class WasmLoadError extends Data.TaggedError('WasmLoadError')<{
  readonly message: string
  readonly cause: unknown
}> {
  constructor(cause: unknown) {
    super({ message: messageOf(cause), cause })
  }
}

/** Binding the iroh endpoint failed. */
export class SpawnError extends Data.TaggedError('SpawnError')<{
  readonly message: string
  readonly cause: unknown
}> {
  constructor(cause: unknown) {
    super({ message: messageOf(cause), cause })
  }
}

/** The endpoint never got a home relay, so nobody can reach this device. */
export class RelayUnreachable extends Data.TaggedError('RelayUnreachable')<{
  readonly message: string
}> {
  constructor() {
    super({ message: 'could not reach a relay server — check the internet connection' })
  }
}

/** Starting the device's node failed. */
export type StartError = NotLeader | NoEd25519 | WasmLoadError | SpawnError | RelayUnreachable

/** Dialing a peer failed (it is offline, the relay is down, …). Retried by the dial loop. */
export class DialError extends Data.TaggedError('DialError')<{
  readonly message: string
  readonly endpointId: string
  readonly cause: unknown
}> {
  constructor(endpointId: string, cause: unknown) {
    super({ message: messageOf(cause), endpointId, cause })
  }
}

/** Sending or receiving on an established connection failed. */
export class ConnectionError extends Data.TaggedError('ConnectionError')<{
  readonly message: string
  readonly cause: unknown
}> {
  constructor(cause: unknown) {
    super({ message: messageOf(cause), cause })
  }
}
