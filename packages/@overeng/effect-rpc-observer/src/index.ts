import { Cause, Clock, Effect, Exit, Option, Queue, Result } from 'effect'
import type { Scope } from 'effect'
import { RpcSchema } from 'effect/rpc'
import type { RpcClient, RpcMessage, RpcMiddleware, RpcServer } from 'effect/rpc'

/** The protocol service being observed. */
export type ObserverSide = 'client' | 'server'
/** The direction of the original request, including reverse RPC. */
export type Direction = 'clientToServer' | 'serverToClient'
/** Wall time for display and monotonic time for durations. */
export interface Timestamp {
  readonly monotonicNanos: string
  readonly wallClockMillis: number
}
/** Transport-scoped correlation preserving the wire identifier's type. */
export interface RequestIdentity {
  readonly observerSide: ObserverSide
  readonly connectionId: string
  readonly direction: Direction
  readonly requestId:
    | { readonly _tag: 'String'; readonly value: string }
    | { readonly _tag: 'Number'; readonly value: number }
}
/** Content-free request admission. */
export interface RequestEvent {
  readonly identity: RequestIdentity
  readonly at: Timestamp
  readonly tag: string
  readonly notification: boolean
}
/** Content-free stream delivery evidence. */
export interface ChunkEvent {
  readonly identity: RequestIdentity
  readonly at: Timestamp
  readonly valueCount: number
}
/** Mutually exclusive terminal classifications. */
export type TerminalOutcome =
  | 'success'
  | 'typedFailure'
  | 'defect'
  | 'interrupted'
  | 'transportFailure'
/** A balanced completion with monotonic elapsed time. */
export interface TerminalEvent {
  readonly identity: RequestIdentity
  readonly at: Timestamp
  readonly outcome: TerminalOutcome
  readonly durationSeconds: number
}
/** Connection-level transport evidence without fault content. */
export interface FaultEvent {
  readonly observerSide: ObserverSide
  readonly connectionId: string
  readonly at: Timestamp
  readonly reason:
    | 'defect'
    | 'clientProtocolError'
    | 'disconnect'
    | 'eof'
    | 'sendFailure'
    | 'capacity'
}
/** Synchronous best-effort metadata consumer. */
export interface ProtocolSink {
  readonly onRequest: (event: RequestEvent) => void
  readonly onChunk: (event: ChunkEvent) => void
  readonly onTerminal: (event: TerminalEvent) => void
  readonly onFault: (event: FaultEvent) => void
}
/** Borrowed content, valid only during the callback. */
export interface RawValue {
  readonly channel:
    | 'payload'
    | 'headers'
    | 'success'
    | 'typedFailure'
    | 'defect'
    | 'streamElement'
    | 'streamError'
  readonly encoding: 'encoded' | 'decoded'
  readonly value: unknown
}
/** Borrowed transport envelope with actual send completion evidence. */
export interface RawMessage {
  readonly clientId: number
  readonly direction: Direction
  readonly phase: 'sendAttempted' | 'sendFinished' | 'received'
  readonly message: RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded
  readonly succeeded?: boolean
  readonly connectionId: string
  readonly at: Timestamp
}
/** Opted-in content consumer responsible for its own capture policy and retention. */
export interface CaptureSink {
  // oxlint-disable-next-line overeng/named-args -- Public callbacks pair metadata with a borrowed attachment.
  readonly onRequest: (event: RequestEvent, raw: readonly RawValue[]) => void
  // oxlint-disable-next-line overeng/named-args -- Public callbacks pair metadata with a borrowed attachment.
  readonly onChunk: (event: ChunkEvent, raw: readonly RawValue[]) => void
  // oxlint-disable-next-line overeng/named-args -- Public callbacks pair metadata with a borrowed attachment.
  readonly onTerminal: (event: TerminalEvent, raw: readonly RawValue[]) => void
  readonly onFault: (event: FaultEvent) => void
  readonly onMessage: (message: RawMessage) => void
}
/** Raw access is an individual registration choice, never a global switch. */
export type SinkRegistration =
  | { readonly capture: false; readonly sink: ProtocolSink }
  | { readonly capture: true; readonly sink: CaptureSink }
const observerBrand: unique symbol = Symbol('ProtocolObserver')
/** One scoped coordinator shared by protocol and decoded middleware seams. */
export interface ProtocolObserver {
  readonly [observerBrand]: State
}
type Entry = {
  readonly identity: RequestIdentity
  readonly started: Timestamp
  readonly tag: string
  readonly notification: boolean
  emitted: boolean
  terminal: boolean
}
type State = {
  readonly side: ObserverSide
  sinks: readonly SinkRegistration[]
  readonly capacity: number
  readonly scope: Scope.Scope
  now: () => Timestamp
  connectionId: (clientId: number) => string
  readonly entries: Map<string, Entry>
  capture: boolean
  released: boolean
}
const safely = (callback: () => void): void => {
  try {
    callback()
  } catch {
    /* Observation cannot alter transport channels. */
  }
}
const keyOf = (identity: RequestIdentity): string =>
  JSON.stringify([
    identity.observerSide,
    identity.connectionId,
    identity.direction,
    identity.requestId._tag,
    identity.requestId.value,
  ])
/** Platform-neutral default timestamps from the ambient Effect clock (high-resolution where the platform provides it). */
const nowFromClock = (clock: Clock.Clock) => (): Timestamp => ({
  monotonicNanos: String(clock.currentTimeNanosUnsafe()),
  wallClockMillis: clock.currentTimeMillisUnsafe(),
})
const identityFor = ({
  state,
  clientId,
  direction,
  requestId,
}: {
  readonly state: State
  readonly clientId: number
  readonly direction: Direction
  readonly requestId: string | number
}): RequestIdentity => ({
  observerSide: state.side,
  connectionId: state.connectionId(clientId),
  direction,
  requestId:
    typeof requestId === 'string'
      ? { _tag: 'String', value: requestId }
      : { _tag: 'Number', value: requestId },
})
const emit = <T extends 'onRequest' | 'onChunk' | 'onTerminal'>({
  state,
  method,
  event,
  raw,
}: {
  readonly state: State
  readonly method: T
  readonly event: T extends 'onRequest'
    ? RequestEvent
    : T extends 'onChunk'
      ? ChunkEvent
      : TerminalEvent
  readonly raw: readonly RawValue[]
}): void => {
  if (state.released === true) return
  for (const registration of state.sinks)
    safely(() => {
      // The discriminated method/event relation is maintained by every call site.
      const callback = registration.sink[method] as (
        event: RequestEvent | ChunkEvent | TerminalEvent,
        raw?: readonly RawValue[],
      ) => void
      if (registration.capture === true) callback(event, raw)
      else callback(event)
    })
}
const emptyRaw: readonly RawValue[] = []
const finish = ({
  state,
  entry,
  outcome,
  raw = emptyRaw,
}: {
  readonly state: State
  readonly entry: Entry
  readonly outcome: TerminalOutcome
  readonly raw?: readonly RawValue[]
}): void => {
  if (entry.terminal === true || state.released === true) return
  entry.terminal = true
  state.entries.delete(keyOf(entry.identity))
  state.entries.set(keyOf(entry.identity), entry)
  if (entry.emitted === false) return
  const at = state.now()
  emit({
    state,
    method: 'onTerminal',
    event: {
      identity: entry.identity,
      at,
      outcome,
      durationSeconds: Math.max(
        0,
        Number(BigInt(at.monotonicNanos) - BigInt(entry.started.monotonicNanos)) / 1_000_000_000,
      ),
    },
    raw,
  })
}
const fault = ({
  state,
  connectionId,
  reason,
  affected,
}: {
  readonly state: State
  readonly connectionId: string
  readonly reason: FaultEvent['reason']
  readonly affected?: Entry
}): void => {
  if (state.released === true) return
  if (affected !== undefined) finish({ state, entry: affected, outcome: 'transportFailure' })
  else
    for (const entry of state.entries.values())
      if (entry.identity.connectionId === connectionId && entry.terminal === false)
        finish({ state, entry, outcome: 'transportFailure' })
  const event: FaultEvent = { observerSide: state.side, connectionId, reason, at: state.now() }
  for (const registration of state.sinks) safely(() => registration.sink.onFault(event))
}
const admit = ({
  state,
  identity,
  tag,
  notification,
  observed,
  raw = emptyRaw,
}: {
  readonly state: State
  readonly identity: RequestIdentity
  readonly tag: string
  readonly notification: boolean
  readonly observed: boolean
  readonly raw?: readonly RawValue[]
}): Entry | undefined => {
  if (state.released === true) return undefined
  const key = keyOf(identity)
  let entry = state.entries.get(key)
  if (entry === undefined || entry.terminal === true) {
    state.entries.delete(key)
    while (state.entries.size >= state.capacity) {
      let victim: Entry | undefined
      for (const candidate of state.entries.values())
        if (candidate.terminal === true) {
          victim = candidate
          break
        }
      victim ??= state.entries.values().next().value
      if (victim === undefined) break
      if (victim.terminal === false)
        fault({
          state,
          connectionId: victim.identity.connectionId,
          reason: 'capacity',
          affected: victim,
        })
      state.entries.delete(keyOf(victim.identity))
    }
    entry = { identity, tag, notification, started: state.now(), emitted: false, terminal: false }
    state.entries.set(key, entry)
  }
  if (observed === true && entry.emitted === false) {
    entry.emitted = true
    emit({
      state,
      method: 'onRequest',
      event: {
        identity: entry.identity,
        at: entry.started,
        tag: entry.tag,
        notification: entry.notification,
      },
      raw,
    })
  }
  return entry
}
const rawEnvelope = ({
  state,
  ...message
}: Omit<RawMessage, 'connectionId' | 'at'> & { readonly state: State }): void => {
  if (state.released === true || state.capture === false) return
  const event: RawMessage = {
    ...message,
    connectionId: state.connectionId(message.clientId),
    at: state.now(),
  }
  for (const registration of state.sinks)
    if (registration.capture === true) safely(() => registration.sink.onMessage(event))
}
const requestRaw = (message: RpcMessage.RequestEncoded): readonly RawValue[] => [
  { channel: 'payload', encoding: 'encoded', value: message.payload },
  { channel: 'headers', encoding: 'encoded', value: message.headers },
]
const observe = ({
  state,
  clientId,
  direction,
  message,
  requestObservation = 'protocol',
}: {
  readonly state: State
  readonly clientId: number
  readonly direction: Direction
  readonly message: RawMessage['message']
  readonly requestObservation?: 'protocol' | 'middleware'
}): Entry | undefined => {
  if (state.released === true) return undefined
  if (message._tag === 'Request') {
    const entry = admit({
      state,
      identity: identityFor({ state, clientId, direction, requestId: message.id }),
      tag: message.tag,
      notification: message.isNotification === true,
      observed: requestObservation === 'protocol',
      raw:
        state.capture === true && requestObservation === 'protocol'
          ? requestRaw(message)
          : emptyRaw,
    })
    return entry
  }
  if (message._tag === 'Defect' || message._tag === 'ClientProtocolError') {
    fault({
      state,
      connectionId: state.connectionId(clientId),
      reason: message._tag === 'Defect' ? 'defect' : 'clientProtocolError',
    })
    return undefined
  }
  if (message._tag !== 'Chunk' && message._tag !== 'Exit') return undefined
  const entry = state.entries.get(
    keyOf(
      identityFor({
        state,
        clientId,
        direction: direction === 'clientToServer' ? 'serverToClient' : 'clientToServer',
        requestId: message.requestId,
      }),
    ),
  )
  if (entry === undefined || entry.terminal === true || entry.emitted === false) return undefined
  if (message._tag === 'Chunk') {
    emit({
      state,
      method: 'onChunk',
      event: { identity: entry.identity, at: state.now(), valueCount: message.values.length },
      raw:
        state.capture === true
          ? message.values.map((value) => ({
              channel: 'streamElement',
              encoding: 'encoded',
              value,
            }))
          : emptyRaw,
    })
    return entry
  }
  if (message.exit._tag === 'Success')
    finish({
      state,
      entry,
      outcome: 'success',
      raw:
        state.capture === true
          ? [{ channel: 'success', encoding: 'encoded', value: message.exit.value }]
          : emptyRaw,
    })
  else {
    let outcome: TerminalOutcome = 'typedFailure'
    const raw: RawValue[] | undefined = state.capture === true ? [] : undefined
    for (const cause of message.exit.cause) {
      if (cause._tag === 'Die') {
        outcome = 'defect'
        raw?.push({ channel: 'defect', encoding: 'encoded', value: cause.defect })
      } else if (cause._tag === 'Interrupt' && outcome !== 'defect') outcome = 'interrupted'
      else if (cause._tag === 'Fail')
        raw?.push({ channel: 'typedFailure', encoding: 'encoded', value: cause.error })
    }
    finish({ state, entry, outcome, raw: raw ?? emptyRaw })
  }
  return entry
}
/** Creates a bounded coordinator whose references and fan-out end with its scope. */
export const makeProtocolObserver = (options: {
  readonly side: ObserverSide
  readonly sinks: readonly SinkRegistration[]
  readonly capacity: number
  readonly clock?: { readonly now: () => Timestamp }
  readonly connectionId?: (clientId: number) => string
}): Effect.Effect<ProtocolObserver, never, Scope.Scope> =>
  Effect.gen(function* () {
    if (Number.isSafeInteger(options.capacity) === false || options.capacity <= 0)
      return yield* Effect.die('Observer capacity must be a positive safe integer')
    const defaultNow = nowFromClock(yield* Clock.Clock)
    const state: State = {
      side: options.side,
      sinks: options.sinks.slice(),
      capacity: options.capacity,
      scope: yield* Effect.scope,
      now: options.clock?.now ?? defaultNow,
      connectionId: options.connectionId ?? String,
      entries: new Map(),
      capture: options.sinks.some((registration) => registration.capture === true),
      released: false,
    }
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        state.released = true
        state.entries.clear()
        state.sinks = []
        state.capture = false
        state.now = defaultNow
        state.connectionId = String
      }),
    )
    return { [observerBrand]: state }
  })
const sendEvidence = ({
  state,
  clientId,
  direction,
  message,
  succeeded,
  outgoing,
}: {
  readonly state: State
  readonly clientId: number
  readonly direction: Direction
  readonly message: RawMessage['message']
  readonly succeeded: boolean
  readonly outgoing?: Entry
}): void => {
  rawEnvelope({ state, clientId, direction, message, phase: 'sendFinished', succeeded })
  if (succeeded === false) {
    let affected = outgoing
    if (affected === undefined && (message._tag === 'Exit' || message._tag === 'Chunk'))
      affected = state.entries.get(
        keyOf(
          identityFor({
            state,
            clientId,
            direction: direction === 'clientToServer' ? 'serverToClient' : 'clientToServer',
            requestId: message.requestId,
          }),
        ),
      )
    if (affected !== undefined)
      fault({ state, connectionId: state.connectionId(clientId), reason: 'sendFailure', affected })
    return
  }
  if (outgoing !== undefined) {
    if (outgoing.notification === true) finish({ state, entry: outgoing, outcome: 'success' })
    return
  }
  observe({ state, clientId, direction, message })
  if (message._tag === 'Eof' && state.side === 'client')
    fault({ state, connectionId: state.connectionId(clientId), reason: 'eof' })
}
/** Observes one client transport while preserving callbacks, messages, and send exits. */
export const decorateClientProtocol = ({
  protocol,
  observer,
}: {
  readonly protocol: RpcClient.Protocol['Service']
  readonly observer: ProtocolObserver
}): RpcClient.Protocol['Service'] => {
  const state = observer[observerBrand]
  return {
    ...protocol,
    // oxlint-disable-next-line overeng/named-args -- Effect owns the positional protocol signature.
    run: (clientId, callback) =>
      Effect.onExit(
        protocol.run(clientId, (message) =>
          Effect.sync(() => {
            rawEnvelope({
              state,
              clientId,
              direction: 'serverToClient',
              message,
              phase: 'received',
            })
            const entry = observe({ state, clientId, direction: 'serverToClient', message })
            if (entry?.notification === true) finish({ state, entry, outcome: 'success' })
          }).pipe(Effect.andThen(Effect.suspend(() => callback(message)))),
        ),
        () =>
          Effect.sync(() =>
            fault({ state, connectionId: state.connectionId(clientId), reason: 'disconnect' }),
          ),
      ),
    // oxlint-disable-next-line overeng/named-args -- Effect owns the positional protocol signature.
    send: (clientId, message, transferables) =>
      Effect.suspend(() => {
        rawEnvelope({
          state,
          clientId,
          direction: 'clientToServer',
          message,
          phase: 'sendAttempted',
        })
        const outgoing =
          message._tag === 'Request'
            ? observe({ state, clientId, direction: 'clientToServer', message })
            : undefined
        return Effect.onExit(protocol.send(clientId, message, transferables), (exit) =>
          Effect.sync(() =>
            sendEvidence({
              state,
              clientId,
              direction: 'clientToServer',
              message,
              succeeded: Exit.isSuccess(exit),
              ...(outgoing === undefined ? {} : { outgoing }),
            }),
          ),
        )
      }),
  }
}
/** Observes one server transport and relays disconnect evidence within the observer scope. */
export const decorateServerProtocol = ({
  protocol,
  observer,
  requestObservation = 'protocol',
}: {
  readonly protocol: RpcServer.Protocol['Service']
  readonly observer: ProtocolObserver
  readonly requestObservation?: 'protocol' | 'middleware'
}): RpcServer.Protocol['Service'] => {
  const state = observer[observerBrand]
  const disconnects = Effect.runSync(Queue.make<number>())
  const subscribe = Queue.take(protocol.disconnects).pipe(
    Effect.tap((clientId) =>
      Effect.sync(() =>
        fault({ state, connectionId: state.connectionId(clientId), reason: 'disconnect' }),
      ),
    ),
    Effect.flatMap((clientId) => Queue.offer(disconnects, clientId)),
    Effect.forever,
    Effect.forkIn(state.scope),
  )
  Effect.runFork(subscribe)
  return {
    ...protocol,
    disconnects,
    run: (callback) =>
      protocol.run((clientId, message) =>
        Effect.sync(() => {
          rawEnvelope({ state, clientId, direction: 'clientToServer', message, phase: 'received' })
          const entry = observe({
            state,
            clientId,
            direction: 'clientToServer',
            message,
            requestObservation,
          })
          if (entry?.notification === true && requestObservation === 'protocol')
            finish({ state, entry, outcome: 'success' })
        }).pipe(Effect.andThen(Effect.suspend(() => callback(clientId, message)))),
      ),
    // oxlint-disable-next-line overeng/named-args -- Effect owns the positional protocol signature.
    send: (clientId, message, transferables) =>
      Effect.suspend(() => {
        rawEnvelope({
          state,
          clientId,
          direction: 'serverToClient',
          message,
          phase: 'sendAttempted',
        })
        const outgoing =
          message._tag === 'Request'
            ? observe({ state, clientId, direction: 'serverToClient', message })
            : undefined
        return Effect.onExit(protocol.send(clientId, message, transferables), (exit) =>
          Effect.sync(() =>
            sendEvidence({
              state,
              clientId,
              direction: 'serverToClient',
              message,
              succeeded: Exit.isSuccess(exit),
              ...(outgoing === undefined ? {} : { outgoing }),
            }),
          ),
        )
      }),
    end: (clientId) =>
      Effect.tap(protocol.end(clientId), () =>
        Effect.sync(() =>
          fault({ state, connectionId: state.connectionId(clientId), reason: 'disconnect' }),
        ),
      ),
  }
}
/** Shares decoded handler evidence with the server protocol's existing coordinator. */
export const makeServerObserverMiddleware = ({
  observer,
}: {
  readonly observer: ProtocolObserver
}): RpcMiddleware.RpcMiddleware<never, never, never> => {
  const state = observer[observerBrand]
  // oxlint-disable-next-line overeng/named-args -- Effect owns the positional middleware signature.
  return (effect, metadata) =>
    Effect.suspend(() => {
      const identity = identityFor({
        state,
        clientId: metadata.client.id,
        direction: 'clientToServer',
        requestId: metadata.requestId,
      })
      const current = state.entries.get(keyOf(identity))
      const entry = admit({
        state,
        identity,
        tag: metadata.rpc._tag,
        notification: current?.notification === true,
        observed: true,
        raw:
          state.capture === true
            ? [
                { channel: 'payload', encoding: 'decoded', value: metadata.payload },
                { channel: 'headers', encoding: 'decoded', value: metadata.headers },
              ]
            : emptyRaw,
      })
      const stream = RpcSchema.isStreamSchema(metadata.rpc.successSchema)
      return Effect.onExit(effect, (exit) =>
        Effect.sync(() => {
          if (entry === undefined) return
          if (exit._tag === 'Success') {
            finish({
              state,
              entry,
              outcome: 'success',
              raw:
                state.capture === true && stream === false
                  ? [{ channel: 'success', encoding: 'decoded', value: exit.value }]
                  : emptyRaw,
            })
            return
          }
          if (Cause.hasDies(exit.cause) === true) {
            const defect = Cause.findDefect(exit.cause)
            finish({
              state,
              entry,
              outcome: 'defect',
              raw:
                state.capture === true && Result.isSuccess(defect) === true
                  ? [{ channel: 'defect', encoding: 'decoded', value: defect.success }]
                  : emptyRaw,
            })
          } else if (Cause.hasInterrupts(exit.cause) === true)
            finish({ state, entry, outcome: 'interrupted' })
          else {
            const failure = Cause.findErrorOption(exit.cause)
            finish({
              state,
              entry,
              outcome: 'typedFailure',
              raw:
                state.capture === true && Option.isSome(failure) === true
                  ? [
                      {
                        channel: stream === true ? 'streamError' : 'typedFailure',
                        encoding: 'decoded',
                        value: failure.value,
                      },
                    ]
                  : emptyRaw,
            })
          }
        }),
      )
    })
}
