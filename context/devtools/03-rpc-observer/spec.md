# Effect RPC Observer Spec

This document specifies shared protocol observation. It builds on [requirements.md](./requirements.md) and the [ontology](../ontology.md).

## Status

Draft. Contracts describe the extraction and clean cutover, not existing exports.

## Scope

Defines content-free correlation, lifecycle fan-out, scoped client/server decorators, and raw attachment opt-in. Does not define an inspection store or content capture policy; those remain in [explorer core](../../effect-rpc-explorer/01-core/spec.md). [RPC integration](../04-rpc-devtools/spec.md) owns RPC meter computation.

## API and event model

```text
public Protocol -> one decorator -> ProtocolObserver coordinator
                                      ├─ ProtocolSink (metadata)
                                      ├─ CaptureSink (transient raw opt-in)
                                      └─ N independent sinks
server middleware --------------------┘
```

Traces: DT.OBS-R01–R07, DT.OBS-R10.

```ts
import type { Effect, Scope } from 'effect'
import type { RpcClient, RpcServer, RpcMessage, RpcMiddleware } from 'effect/rpc'

export type ObserverSide = 'client' | 'server'
export type Direction = 'clientToServer' | 'serverToClient'
export interface Timestamp {
  readonly monotonicNanos: string
  readonly wallClockMillis: number
}
export interface RequestIdentity {
  readonly observerSide: ObserverSide
  readonly connectionId: string
  readonly direction: Direction
  readonly requestId:
    | { readonly _tag: 'String'; readonly value: string }
    | { readonly _tag: 'Number'; readonly value: number }
}
export interface RequestEvent {
  readonly identity: RequestIdentity
  readonly at: Timestamp
  readonly tag: string
  readonly notification: boolean
}
export interface ChunkEvent {
  readonly identity: RequestIdentity
  readonly at: Timestamp
  readonly valueCount: number
}
export type TerminalOutcome =
  'success' | 'typedFailure' | 'defect' | 'interrupted' | 'transportFailure'
export interface TerminalEvent {
  readonly identity: RequestIdentity
  readonly at: Timestamp
  readonly outcome: TerminalOutcome
  readonly durationSeconds: number
}
export interface FaultEvent {
  readonly observerSide: ObserverSide
  readonly connectionId: string
  readonly at: Timestamp
  readonly reason:
    'defect' | 'clientProtocolError' | 'disconnect' | 'eof' | 'sendFailure' | 'capacity'
}
export interface ProtocolSink {
  readonly onRequest: (event: RequestEvent) => void
  readonly onChunk: (event: ChunkEvent) => void
  readonly onTerminal: (event: TerminalEvent) => void
  readonly onFault: (event: FaultEvent) => void
}
export interface RawValue {
  readonly channel:
    'payload' | 'headers' | 'success' | 'typedFailure' | 'defect' | 'streamElement' | 'streamError'
  readonly encoding: 'encoded' | 'decoded'
  readonly value: unknown
}
export interface RawMessage {
  readonly clientId: number
  readonly connectionId: string
  readonly at: Timestamp
  readonly direction: Direction
  readonly phase: 'sendAttempted' | 'sendFinished' | 'received'
  readonly message: RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded
  readonly succeeded?: boolean
}
export interface CaptureSink {
  readonly onRequest: (event: RequestEvent, raw: readonly RawValue[]) => void
  readonly onChunk: (event: ChunkEvent, raw: readonly RawValue[]) => void
  readonly onTerminal: (event: TerminalEvent, raw: readonly RawValue[]) => void
  readonly onFault: (event: FaultEvent) => void
  readonly onMessage: (message: RawMessage) => void
}
export type SinkRegistration =
  | { readonly capture: false; readonly sink: ProtocolSink }
  | { readonly capture: true; readonly sink: CaptureSink }
declare const observerBrand: unique symbol
export interface ProtocolObserver {
  readonly [observerBrand]: true
}
export declare const makeProtocolObserver: (options: {
  readonly side: ObserverSide
  readonly sinks: readonly SinkRegistration[]
  readonly capacity: number
  readonly clock?: { readonly now: () => Timestamp }
  readonly connectionId?: (clientId: number) => string
}) => Effect.Effect<ProtocolObserver, never, Scope.Scope>
export declare const decorateClientProtocol: (options: {
  readonly protocol: RpcClient.Protocol['Service']
  readonly observer: ProtocolObserver
}) => RpcClient.Protocol['Service']
export declare const decorateServerProtocol: (options: {
  readonly protocol: RpcServer.Protocol['Service']
  readonly observer: ProtocolObserver
  readonly requestObservation?: 'protocol' | 'middleware'
}) => RpcServer.Protocol['Service']
export declare const makeServerObserverMiddleware: (options: {
  readonly observer: ProtocolObserver
}) => RpcMiddleware.RpcMiddleware<never, never, never>
```

These are public declaration signatures; namespaces denote existing Effect/RPC modules, not an added aggregate export requirement. `streamElement` intentionally retains explorer's current capture-channel spelling. Raw lifecycle callbacks receive only relevant channels; raw envelopes also expose Ack/Interrupt/Ping/EOF and send evidence. Capture adapters must not dispatch a second request/chunk/terminal from `onMessage`.

Raw envelopes carry the coordinator-resolved connection identity and timestamp,
so capture adapters never duplicate host identity resolution. A Request envelope
is delivered before its canonical `onRequest`, allowing immediate extraction of
bounded trace metadata without retaining the envelope. `sendFinished` precedes
any terminal/fault generated by that send. In middleware mode the capture sink
may keep only extracted trace metadata until the decoded request callback.

The package owns repository-public, closed TypeScript discriminator unions above; they are not new wire fields. Values are case-sensitive, exact spellings. Unknown upstream message tags are passed through unchanged and ignored for lifecycle accounting, not coerced into a known outcome. Adding an outcome is a contract change requiring consumers to handle it. Example valid outcome: `typedFailure`; invalid: `error`. Connection and RPC tag strings are opaque host/wire-owned names, not parsed namespaces. Identity equality uses the full tuple; numeric `1` and string `"1"` are distinct. Monotonic nanoseconds use nonnegative base-10 integer strings, while wall time is finite epoch milliseconds. Duration is derived only from the monotonic clock.

## Correlation, ordering, and bounded retention

```text
unknown --Request--> active --Chunk*--> active --terminal evidence--> terminal tombstone
                           --fault/capacity loss-------------------> terminal tombstone
late Chunk/Exit without active request -> ignored
```

Traces: DT.OBS-R02, DT.OBS-R04, DT.OBS-R06–R10.

A canonical event is computed once, then delivered synchronously in registration order. Every callback is separately exception-isolated. Sinks may not mutate shared events or raw input; no per-sink event clone is required. Correlation state stores identity, request start, observation phase and scalar bookkeeping, never messages or values. No store-keyed WeakMap remains: one scoped observer is the coordinator shared by its decoration and middleware.

`capacity` is a positive safe integer bounding active entries plus terminal tombstones. Evict oldest tombstones first. If all entries are active, terminalize the oldest active request as `transportFailure`, emit a `capacity` fault for its connection, then make room. Eviction never silently leaks in-flight accounting. Tombstones suppress duplicate terminal evidence while retained; once evicted, an unsolicited Exit/Chunk is still ignored. A new Request may reuse a completed wire ID; transport ordering must prevent stale responses being ambiguous with such reuse. New transport lifetimes require distinct connection identity.

Each observed request gets one `onRequest`, zero or more `onChunk`, and at most one `onTerminal`. A chunk reports its entire value count, independent of explorer retention limits. Outgoing request observation precedes the actual send so synchronous loopback responses can correlate. A late send failure cannot terminalize a request already settled by earlier response evidence. Unmapped response evidence is not a fabricated request or latency sample.

Server middleware mode registers inbound identity at protocol entry but emits the request lifecycle at decoded middleware entry, before handler execution. Middleware supplies decoded payload/headers and terminal values on the canonical callbacks; protocol evidence settles the same coordinator. First terminal evidence wins, including outcome and raw representation. Middleware cannot create another request or terminal. Protocol mode requires no middleware; installing both as independent coordinators is prohibited.

## Transport sequencing and terminal classification

| Evidence                                    | Canonical treatment                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Client outbound Request                     | raw send attempt, request, original send, raw send finished                                                                     |
| Server outbound reverse Request             | same sequence with `serverToClient` identity direction                                                                          |
| Notification send success                   | terminal `success` at send completion; this means transport acceptance, not remote execution                                    |
| Notification received                       | terminal `success` at receipt in protocol mode, or handler completion in middleware mode                                        |
| Request send failure/interrupted send       | `transportFailure` plus `sendFailure`; preserve the original Effect exit                                                        |
| Inbound Chunk                               | chunk before forwarding original callback                                                                                       |
| Exit success                                | terminal `success`                                                                                                              |
| Exit failure cause                          | `defect` if any Die, else `interrupted` if any Interrupt, else `typedFailure`                                                   |
| Ack                                         | transient envelope only; no terminal                                                                                            |
| Interrupt envelope                          | transient envelope only; wait for terminal/fault evidence                                                                       |
| Connection defect/protocol error/disconnect | settle active requests on that side/connection as `transportFailure`, then emit fault                                           |
| Client outbound EOF                         | explicit EOF fault for a transport ending its request lifetime                                                                  |
| Server inbound EOF                          | body/batch-end envelope only; active requests remain serviceable                                                                |
| Scope release                               | stop fan-out, release disconnect subscription and coordinator references; source owners release their state with the same scope |

Traces: DT.OBS-R05, DT.OBS-R08–R10. For a terminal server response, observe a send attempt but commit successful chunk/terminal evidence only on successful send completion; failed response send settles the affected request as transport failure. Capture `onMessage` exposes both phases without falsely declaring delivery. Preserve server `disconnects` and all capability fields; subscribe within the observer scope to real disconnect evidence. Preserve `end`'s original Effect result, observing successful connection closure; do not replace transport errors with observation errors. Duplicate fault evidence must not create duplicate request terminals. Fault callbacks are fault evidence, not an additional error-rate count.

## Transient capture and explorer cutover

```text
shared observer CaptureSink -> explorer policy/codec -> explorer store -> inspector
shared observer ProtocolSink -> RPC source (no values)
```

Traces: DT.OBS-R01, DT.OBS-R03, DT.OBS-R11–R12.

Raw attachments are callback-lifetime borrowed references, delivered only when `capture: true`; no raw arrays or payload traversal are constructed for metadata-only observation. A capture sink is responsible for immediate policy application and bounded retained normalized data. The observer never invokes codecs, schema traversal, redaction, telemetry normalization, or a retention policy.

```ts
import type { ExplorerServices, ExplorerEncodedDecodersByTag } from '@overeng/effect-rpc-explorer'

// The revised ExplorerServices contains this method instead of decoration/middleware.
export interface ExplorerCaptureSurface {
  readonly makeCaptureSink: (options: {
    readonly side: ObserverSide
    readonly encodedDecodersByTag?: ExplorerEncodedDecodersByTag
  }) => CaptureSink
}
```

Explorer retains descriptors, store, inspector, telemetry, and scoped descriptor registration. Remove its public `ProtocolObserver`, `makeProtocolObserver`, protocol decorators, server observation middleware, decorator option types, and corresponding `ExplorerServices.decorateClientProtocol`, `.decorateServerProtocol`, and `.middleware`. Replace all callers, tests, examples, and associated explorer VRS references with the shared package plus capture sink. Do not re-export removed observation APIs as aliases. Standalone explorer constructs `makeExplorer`, its capture sink, and `makeProtocolObserver` directly; it does not need rpc-devtools or devbar.

## Conformance

Replay fixtures cover notification, unary and streaming success, typed failure, defect precedence, interruption, send failure, synchronous loopback, duplicate terminal, unknown IDs, request-ID type distinction/reuse, separate connections, capacity loss, server batch EOF, actual disconnect, and protocol+middleware deduplication. Assert identical transport outputs/Effect exits/transferables/capabilities with and without decoration. Register metadata and capture sinks together; assert one lifecycle stream, deterministic fan-out, exception isolation, no raw attachment to metadata sink, and no payload access when no capture sink is registered. Scope close must remove observer-owned subscriptions and references. These fixtures prove DT.OBS-R01–R12 without relying on explorer normalization-duration telemetry as request latency.
