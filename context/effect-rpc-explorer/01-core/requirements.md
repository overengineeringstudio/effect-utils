# Effect RPC Explorer Core Requirements

## Context

The core package realizes capture and inspection for the
[Effect RPC Explorer requirements](../requirements.md). It owns descriptors,
observation seams, safe normalization, correlation, bounded state, the inspector
protocol, and pipeline telemetry. It has no React surface.

## Assumptions

- **RPCX.CORE-A01 Root contract:** This subsystem refines RPCX-R01 through
  RPCX-R23 and RPCX-R28 through RPCX-R30 where they concern the core.
- **RPCX.CORE-A02 Ordered runtime:** The implementation may use one serialized
  Effect-owned mutation boundary for consistency rather than concurrent writes
  to several projections.
- **RPCX.CORE-A03 Monotonic clock:** Durations use a monotonic host clock; wall
  time is display metadata only.

## Acceptable Tradeoffs

- **RPCX.CORE-T01 Model eviction:** When bounds conflict with complete history,
  the core preserves boundedness and emits content-free gap evidence.
- **RPCX.CORE-T02 Best-effort schema projection:** A channel may retain a live
  schema while its JSON Schema projection is partial or unavailable.
- **RPCX.CORE-T03 Optional decoding:** Protocol-level serialized holes may remain
  typed opaque placeholders when decoding services are unavailable.

## Requirements

### Must expose one composable core

- **RPCX.CORE-R01 Package boundary:**
  `@overeng/effect-rpc-explorer` must expose capture decorators, middleware,
  descriptor construction, store, inspector group, schemas, and configuration
  without depending on React or starting a transport.
  Refines: RPCX-R01, RPCX-R03, RPCX-R04.
- **RPCX.CORE-R02 Diagnostic API:** Inspector methods must be limited to
  descriptor, snapshot, watch, health reads, and explicit clearing of completed
  explorer history, obsolete replay data, and events unreferenced by active
  records. They must preserve active records and must not expose application-RPC
  dispatch, replay, retry, cancellation, or mutation.
  Refines: RPCX-R02.
- **RPCX.CORE-R03 Ephemeral state:** Core state must be memory-only and scoped to
  the explorer Layer lifetime; disposal must stop subscriptions and release all
  retained values.
  Refines: RPCX-R20.

### Must construct authoritative descriptors

- **RPCX.CORE-R04 Group enumeration:** Descriptor construction must enumerate
  `RpcGroup.requests` and use public `Rpc` properties for key, annotations,
  payload/success/error/defect schemas, and middleware.
  Refines: RPCX-R06, RPCX-R10.
- **RPCX.CORE-R05 Stream schemas:** Stream detection must use the public
  `RpcSchema.isStreamSchema` guard and its public success/error fields, never
  the internal stream helper or direct AST traversal.
  Refines: RPCX-R06, RPCX-R11.
- **RPCX.CORE-R06 Logical mapping:** A host logical-RPC mapper may map an observed
  physical message only to an existing descriptor ID. An absent or invalid
  mapping must produce an unknown-descriptor observation, not an inferred
  schema or fabricated descriptor.
  Refines: RPCX-R08, RPCX-R10.
- **RPCX.CORE-R07 Projection honesty:** JSON Schema generation must preserve
  projection warnings and must never be used as the decoding or validation
  authority.
  Refines: RPCX-R11.

### Must observe complete lifecycle seams

- **RPCX.CORE-R08 Middleware semantics:** Server middleware must record decoded
  request metadata and one correlated handler terminal cause. Client middleware
  must not be treated as proof that a response completed.
  Refines: RPCX-R05, RPCX-R06, RPCX-R08.
- **RPCX.CORE-R09 Protocol transparency:** Client and server Protocol decorators
  must forward `run`, `send`, lifecycle effects, codec, capability booleans,
  initial message, client IDs, disconnect stream, transferables, and errors with
  application-visible behavior unchanged.
  Refines: RPCX-R05, RPCX-R06.
- **RPCX.CORE-R10 Encoded vocabulary:** Decorators must observe Request, Chunk,
  Ack, Interrupt, Exit, notification, EOF/disconnect, protocol fault, send
  attempt, send success, and send failure without assuming one transport codec.
  Refines: RPCX-R05, RPCX-R09.
- **RPCX.CORE-R11 Batch accounting:** One Chunk envelope containing N values must
  increment envelope count by one and stream-value count by N, retaining only
  the configured number of normalized values.
  Refines: RPCX-R05, RPCX-R09, RPCX-R17.

### Must correlate without lying

- **RPCX.CORE-R12 Identity key:** The request key must include observer side,
  opaque connection ID, direction, and a tagged string-or-number request ID.
  Refines: RPCX-R07.
- **RPCX.CORE-R13 State machine:** Requests must transition only through the
  specified lifecycle machine. Duplicate, late, or contradictory events must
  create anomaly evidence without rewriting a prior terminal outcome.
  Refines: RPCX-R08, RPCX-R09.
- **RPCX.CORE-R14 Notifications:** A notification must reach the explicit
  `notificationSent` state after successful send and must not remain pending for
  a response that the protocol does not promise.
  Refines: RPCX-R08.
- **RPCX.CORE-R15 Connection faults:** An uncorrelated Defect,
  ClientProtocolError, or disconnect must remain a standalone connection event
  and mark each currently active request on that connection `uncertain` with
  the same fault reference. A client-side EOF (no further responses can arrive)
  carries the same connection-fault semantics; a server-side EOF is a transport
  fact that must not create an event or touch any in-flight request, because
  transports emit it per request batch while responses are still pending.
  Refines: RPCX-R08.
- **RPCX.CORE-R16 Send semantics:** Attempted, succeeded, and failed sends must be
  distinct facts. A successful send must not imply application completion; a
  failed request send must produce `sendFailed` without claiming handler entry.
  Refines: RPCX-R05, RPCX-R08, RPCX-R09.

### Must enforce capture policy before retention

- **RPCX.CORE-R17 Channel completeness:** The resolver must handle all seven
  channels independently and require exhaustive handling when a channel is
  added.
  Refines: RPCX-R12.
- **RPCX.CORE-R18 Resolution precedence:** Per channel, resolution must use host,
  RPC Context, root Schema, then default `omit`; headers must skip only the
  inapplicable Schema level.
  Refines: RPCX-R13.
- **RPCX.CORE-R19 Whole-channel semantics:** Policies must be `omit`, `reveal`,
  or `redact(transform)` for the entire channel. The API must not promise
  heuristic or generic nested field redaction.
  Refines: RPCX-R12, RPCX-R13.
- **RPCX.CORE-R20 Storage ordering:** No raw channel value may enter an event,
  queue, delta, log, metric, or retained closure before policy and detached
  normalization finish.
  Refines: RPCX-R14.
- **RPCX.CORE-R21 Fail-closed faults:** A throwing/defective redaction transform,
  decoding fault, normalization fault, unsupported cyclic structure, or limit
  fault must retain no raw content and must emit only bounded content-free
  policy evidence.
  Refines: RPCX-R14, RPCX-R17.
- **RPCX.CORE-R22 Redacted boundary:** Normalization must replace every Effect
  `Redacted` wrapper with a placeholder and must not call an operation that
  extracts, encodes, or retains its backing value.
  Refines: RPCX-R15.
- **RPCX.CORE-R23 Inclusion separation:** A dedicated observation-inclusion
  annotation must default to include for host RPCs and be fixed to exclude on
  every inspector RPC. It must not share representation or precedence with
  capture policy.
  Refines: RPCX-R16.

### Must keep state bounded and consistent

- **RPCX.CORE-R24 Independent bounds:** Configuration must separately bound
  completed count/age, active count/age, per-record stream values, normalized
  value depth/entries/bytes, delta replay count/age, and subscriber queue size.
  Refines: RPCX-R17.
- **RPCX.CORE-R25 Observable loss:** Truncation, active/completed eviction,
  unknown late events, and subscriber reset must update content-free counters
  and record evidence where a record still exists.
  Refines: RPCX-R08, RPCX-R17.
- **RPCX.CORE-R26 Single-writer revision:** Every accepted model mutation must
  atomically update state, increment revision once, append one delta, and then
  publish it; ignored duplicates must not increment revision.
  Refines: RPCX-R18, RPCX-R19.
- **RPCX.CORE-R27 Race-free watch:** Snapshot/replay selection and subscriber
  registration must share the mutation boundary. A Watch without
  `afterRevision` must begin with a snapshot; a client requesting an unavailable
  revision must receive an explicit reset followed by a snapshot; a replaying
  client must receive a contiguous revision sequence.
  Refines: RPCX-R18, RPCX-R19.
- **RPCX.CORE-R28 Typed NDJSON:** Snapshot, delta, reset, and protocol-error frames
  must be Effect-Schema encoded, versioned, newline-delimited, and reject an
  unknown major protocol version.
  Refines: RPCX-R18.
- **RPCX.CORE-R29 Recursive exclusion:** Inspector Request/Chunk/Ack/Interrupt/
  Exit traffic, including snapshot, watch, and clear-history RPCs, must be
  rejected by inclusion before policy, model mutation, and telemetry counting.
  Refines: RPCX-R16, RPCX-R18.

### Must integrate with host telemetry

- **RPCX.CORE-R30 Trace fields:** Valid trace ID, span ID, and sampled fields from
  a request or current middleware context must be copied into the record
  without inventing values or changing trace parentage.
  Refines: RPCX-R21.
- **RPCX.CORE-R31 Span restraint:** Core operation must emit no per-call span.
  Only an unexpected explorer pipeline invariant fault may emit the named
  internal fault span with closed-enum attributes and an optional trace link.
  Refines: RPCX-R22.
- **RPCX.CORE-R32 Metric safety:** Metrics must use only the specified instruments
  and closed-enum attributes and must exclude all content, paths, tags,
  descriptor IDs, connection IDs, and request IDs.
  Refines: RPCX-R21, RPCX-R23.

### Must carry focused proof

- **RPCX.CORE-R33 Core verification:** Tests must cover every state transition,
  typed identity boundary, descriptor kind, seven-channel precedence case,
  fail-closed path, Redacted normalization, bound, race/reset and clear-history
  path (including active-record preservation), recursive exclusion, and
  telemetry prohibition.
  Refines: RPCX-R28.
- **RPCX.CORE-R34 Transport contract:** The shared in-memory public-seam
  conformance suite must cover unary success, typed failure, stream batch/Ack,
  cancellation, send failure, and uncorrelated connection fault. Each adopter
  must run one focused real-transport smoke for its selected integration.
  Refines: RPCX-R29.
- **RPCX.CORE-R35 Version gate:** Support for an Effect release must be based on
  compilation plus rerun compatibility evidence at that exact source revision,
  not inference from an earlier RC.
  Refines: RPCX-R30.
