import { createRequire } from 'node:module'
import type * as Native from '@number0/iroh'
import { Cause, Context, Effect, Layer, Schema, Scope, Sink, Stream } from 'effect'

/** Serializable addressing hints; the public key remains the authenticated identity. */
export const NodeAddr = Schema.Struct({
  id: Schema.NonEmptyString,
  relayUrl: Schema.optional(Schema.String),
  directAddresses: Schema.Array(Schema.NonEmptyString),
}).annotate({ identifier: 'Iroh.NodeAddr' })
export type NodeAddr = typeof NodeAddr.Type

/** Native module loading or endpoint binding failed. */
export class IrohInitError extends Schema.TaggedError<IrohInitError>()('IrohInitError', {
  message: Schema.String, cause: Schema.Defect(),
}) {}

/** An operation on an endpoint, connection, or stream failed. */
export class IrohTransportError extends Schema.TaggedError<IrohTransportError>()('IrohTransportError', {
  operation: Schema.String, message: Schema.String, cause: Schema.Defect(),
}) {}

/** A frame or its Schema payload violated the protocol. */
export class IrohProtocolError extends Schema.TaggedError<IrohProtocolError>()('IrohProtocolError', {
  operation: Schema.String, message: Schema.String, cause: Schema.Defect(),
}) {}

/** Endpoint configuration. The default preset enables n0 relays and discovery. */
export interface EndpointOptions {
  readonly alpns: readonly string[]
  readonly preset?: 'n0' | 'minimal'
  readonly bindAddr?: string
  readonly secretKey?: Uint8Array
  /** Explicit rebuilt native module; avoids the global NAPI-RS override. */
  readonly nativeLibraryPath?: string
}

const encoder = new TextEncoder()
const transportError = (operation: string, cause: unknown) => new IrohTransportError({
  operation, message: `iroh ${operation} failed`, cause,
})
const closeConnection = (connection: Native.Connection) => connection.close(0n, [])

/**
 * Upstream promises have no AbortSignal. Interruption closes their owning
 * connection (or endpoint for accept/connect), then waits for native settlement.
 * This is intentionally stronger than silently abandoning a live Rust future.
 */
const nativeCall = <A>(
  operation: string,
  start: () => Promise<A>,
  cancel: () => void | Promise<void>,
  releaseLate?: (value: A) => void | Promise<void>,
): Effect.Effect<A, IrohTransportError> => Effect.callback<A, IrohTransportError>((resume) => {
  let promise: Promise<A>
  try { promise = start() } catch (cause) {
    resume(Effect.fail(transportError(operation, cause)))
    return
  }
  let interrupted = false
  promise.then(
    (value) => { if (interrupted === false) resume(Effect.succeed(value)) },
    (cause) => { if (interrupted === false) resume(Effect.fail(transportError(operation, cause))) },
  )
  return Effect.promise(async () => {
    interrupted = true
    await cancel()
    await promise.then(async (value) => { await releaseLate?.(value) }, () => {})
  })
}).pipe(Effect.withSpan(`Iroh.${operation}`))

/** One bidirectional QUIC stream. Choose raw bytes OR a message codec per half. */
export interface IrohBiStream {
  readonly read: Stream.Stream<Uint8Array, IrohTransportError>
  /** Writes are backpressured; successful upstream completion sends QUIC FIN. */
  readonly write: Sink.Sink<void, Uint8Array, never, IrohTransportError>
  readonly close: Effect.Effect<void>
  readonly messages: <S extends Schema.Constraint>(schema: S, options?: { readonly maxFrameBytes?: number }) => {
    readonly read: Stream.Stream<S['Type'], IrohTransportError | IrohProtocolError, S['DecodingServices']>
    readonly write: Sink.Sink<void, S['Type'], never, IrohTransportError | IrohProtocolError, S['EncodingServices']>
  }
}

const makeBi = (connection: Native.Connection, bi: Native.BiStream): IrohBiStream => {
  const send = bi.send
  const recv = bi.recv
  const cancel = () => closeConnection(connection)
  let sendFinished = false
  let recvFinished = false
  const readChunk = (size: number) => nativeCall('read', async () => {
    const bytes = await recv.read(size)
    if (bytes.length === 0) recvFinished = true
    return bytes
  }, cancel)
  const exact = (size: number) => nativeCall('readExact', () => recv.readExact(size), cancel)
  const writeBytes = (bytes: Uint8Array) => nativeCall('write', () => send.writeAll(Array.from(bytes)), cancel)
  const finish = nativeCall('finish', async () => {
    await send.finish()
    sendFinished = true
  }, cancel)
  return {
    close: Effect.promise(async () => {
      if (connection.closeReason() !== null) return
      if (sendFinished === false) { await send.reset(0n); sendFinished = true }
      if (recvFinished === false) { await recv.stop(0n); recvFinished = true }
    }),
    read: Stream.fromEffectRepeat(Effect.gen(function* () {
      const bytes = yield* readChunk(64 * 1024)
      if (bytes.length === 0) return yield* Cause.done()
      return Uint8Array.from(bytes)
    })),
    write: Sink.forEach(writeBytes).pipe(Sink.mapEffect(() => finish)),
    messages: <S extends Schema.Constraint>(schema: S, options?: { readonly maxFrameBytes?: number }) => {
      const maxFrameBytes = options?.maxFrameBytes ?? 1024 * 1024
      const json = Schema.fromJsonString(schema)
      const decode = Schema.decodeUnknownEffect(json)
      const encode = Schema.encodeEffect(json)
      const protocolError = (operation: string, message: string, cause?: unknown) =>
        new IrohProtocolError({ operation, message, cause })
      const checkSize = (size: number) => size > 0 && size <= maxFrameBytes
        ? Effect.void
        : Effect.fail(protocolError('frame', `Frame length ${size} exceeds limit ${maxFrameBytes} or is empty`))
      const validLimit = Number.isSafeInteger(maxFrameBytes) && maxFrameBytes > 0 && maxFrameBytes <= 0xffffffff
      const read = Stream.fromEffectRepeat(Effect.gen(function* () {
        if (validLimit === false) return yield* protocolError('frame', 'maxFrameBytes must be a positive u32')
        const first = yield* readChunk(4)
        if (first.length === 0) return yield* Cause.done()
        const rest = first.length < 4 ? yield* exact(4 - first.length) : []
        const header = Uint8Array.from([...first, ...rest])
        const size = new DataView(header.buffer).getUint32(0, false)
        yield* checkSize(size)
        const payload = Uint8Array.from(yield* exact(size))
        const text = yield* Effect.try({
          try: () => new TextDecoder('utf-8', { fatal: true }).decode(payload),
          catch: (cause) => protocolError('decode', 'Frame is not valid UTF-8', cause),
        })
        return yield* decode(text).pipe(Effect.mapError((cause) => protocolError('decode', 'Frame failed Schema decoding', cause)))
      }))
      const write = Sink.forEach(Effect.fn('Iroh.encodeFrame')(function* (value: S['Type']) {
        if (validLimit === false) return yield* protocolError('frame', 'maxFrameBytes must be a positive u32')
        const text = yield* encode(value).pipe(Effect.mapError((cause) => protocolError('encode', 'Message failed Schema encoding', cause)))
        const payload = encoder.encode(text)
        yield* checkSize(payload.length)
        const frame = new Uint8Array(4 + payload.length)
        new DataView(frame.buffer).setUint32(0, payload.length, false)
        frame.set(payload, 4)
        yield* writeBytes(frame)
      })).pipe(Sink.mapEffect(() => finish))
      return { read, write }
    },
  }
}

/** A scoped authenticated connection. Bi-stream interruption closes this connection. */
export interface IrohConnection {
  readonly remoteId: string
  readonly alpn: string
  readonly openBi: Effect.Effect<IrohBiStream, IrohTransportError, Scope.Scope>
  readonly acceptBi: Effect.Effect<IrohBiStream, IrohTransportError, Scope.Scope>
  readonly paths: Effect.Effect<readonly Native.PathSnapshot[], IrohTransportError>
  readonly close: Effect.Effect<void>
}

const makeConnection = (connection: Native.Connection): IrohConnection => {
  const close = Effect.sync(() => closeConnection(connection))
  const acquireBi = (operation: 'openBi' | 'acceptBi') => Effect.acquireRelease(
    nativeCall(operation, () => connection[operation](), () => closeConnection(connection))
      .pipe(Effect.map((bi) => makeBi(connection, bi))),
    (bi) => bi.close,
    { interruptible: true },
  )
  return {
    remoteId: connection.remoteId().toString(),
    alpn: new TextDecoder().decode(Uint8Array.from(connection.alpn())),
    openBi: acquireBi('openBi'), acceptBi: acquireBi('acceptBi'), close,
    paths: Effect.try({ try: () => connection.paths(), catch: (cause) => transportError('paths', cause) }),
  }
}

/** Endpoint service: its Layer owns bind/close, callers own connection scopes. */
export class IrohEndpoint extends Context.Service<IrohEndpoint, {
  readonly address: Effect.Effect<NodeAddr, IrohTransportError>
  readonly online: Effect.Effect<void, IrohTransportError>
  readonly connect: (nodeAddr: NodeAddr, alpn: string) => Effect.Effect<IrohConnection, IrohTransportError, Scope.Scope>
  readonly accept: Effect.Effect<IrohConnection | undefined, IrohTransportError, Scope.Scope>
  readonly close: Effect.Effect<void>
}>()('@overeng/effect-iroh/IrohEndpoint') {
  static readonly make = Effect.fn('Iroh.bind')(function* (options: EndpointOptions) {
    const native = yield* Effect.try({
      try: (): typeof Native => {
        const require = createRequire(import.meta.url)
        // npm 1.1.0 has a stale main field; the actual published loader is here.
        return require(options.nativeLibraryPath ?? '@number0/iroh/index.js')
      },
      catch: (cause) => new IrohInitError({ message: 'Unable to load the official iroh Node native binding', cause }),
    })
    const endpoint = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => {
          const builder = native.Endpoint.builder()
          if (options.preset === 'minimal') builder.applyMinimal()
          else builder.applyN0()
          builder.alpns(options.alpns.map((alpn) => Array.from(encoder.encode(alpn))))
          if (options.bindAddr !== undefined) builder.bindAddr(options.bindAddr)
          if (options.secretKey !== undefined) builder.secretKey(Array.from(options.secretKey))
          return builder.bind()
        },
        catch: (cause) => new IrohInitError({ message: 'Unable to bind iroh endpoint', cause }),
      }),
      (endpoint) => Effect.promise(() => endpoint.close()),
    )
    const close = Effect.promise(() => endpoint.close())
    const own = (acquire: Effect.Effect<Native.Connection, IrohTransportError>) => Effect.acquireRelease(
      acquire, (connection) => Effect.sync(() => closeConnection(connection)), { interruptible: true },
    ).pipe(Effect.map(makeConnection))
    const connect = Effect.fn('Iroh.connect')(function* (nodeAddr: NodeAddr, alpn: string) {
      const addr = yield* Effect.try({
        try: () => new native.EndpointAddr(native.EndpointId.fromString(nodeAddr.id), nodeAddr.relayUrl, [...nodeAddr.directAddresses]),
        catch: (cause) => transportError('address', cause),
      })
      return yield* own(nativeCall('connect', () => endpoint.connect(addr, Array.from(encoder.encode(alpn))),
        () => endpoint.close(), closeConnection))
    })
    const accept = Effect.acquireRelease(
      nativeCall('accept', async () => {
        const incoming = await endpoint.acceptNext()
        if (incoming === null) return undefined
        const accepting = await incoming.accept()
        return accepting.connect()
      }, () => endpoint.close(), (connection) => { if (connection !== undefined) closeConnection(connection) }),
      (connection) => Effect.sync(() => { if (connection !== undefined) closeConnection(connection) }),
      { interruptible: true },
    ).pipe(Effect.map((connection) => connection === undefined ? undefined : makeConnection(connection)))
    return {
      address: Effect.try({
        try: () => {
          const addr = endpoint.addr()
          const relayUrl = addr.relayUrl()
          return { id: addr.id().toString(), directAddresses: addr.directAddresses(), ...(relayUrl === null ? {} : { relayUrl }) }
        },
        catch: (cause) => transportError('address', cause),
      }),
      online: nativeCall('online', () => endpoint.online(), () => endpoint.close()),
      connect, accept, close,
    }
  })

  static readonly layer = (options: EndpointOptions) => Layer.effect(this, this.make(options))
}
