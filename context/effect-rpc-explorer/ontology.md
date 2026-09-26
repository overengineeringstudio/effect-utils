# Effect RPC Explorer Ontology

## Language

**Explorer.** The embedded, read-only diagnostic system that projects live
Effect RPC activity into a bounded inspection model. _Avoid:_ collector,
tracer, debugger.

**Observer.** The core component attached to supported middleware and Protocol
seams that turns one runtime signal into an event candidate.

**Observation inclusion.** The independent decision whether a logical RPC may
produce explorer observations. _Avoid:_ capture policy; exclusion hides the
explorer's own inspector group before any content logic runs.

**Capture channel.** One independently governed content category:
`requestPayload`, `success`, `typedFailure`, `defect`, `streamElement`,
`streamError`, or `headers`.

**Capture policy.** A whole-channel instruction to `omit`, `reveal`, or
`redact` through a trusted transform. _Avoid:_ redaction heuristic.

**Policy source.** The winning layer of a channel's capture policy: host, RPC,
Schema, or package default.

**Normalization.** Construction of a detached, bounded, serializable value
algebra from an allowed post-policy value. _Avoid:_ serialization; it never
retains raw runtime objects.

**Redacted placeholder.** The irreversible normalized representation of an
Effect `Redacted` value; it contains no wrapper or backing value.

**Descriptor.** The single logical-RPC description built from an `RpcGroup`'s
public `Rpc` values, including kind and channel schemas.

**Logical-RPC mapper.** A host-supplied mapping from a physical transport
envelope to an existing Descriptor where physical multiplexing hides the
logical schema. _Avoid:_ descriptor generator.

**Physical envelope.** An encoded public Protocol message such as Request,
Chunk, Ack, Interrupt, Exit, or connection fault.

**Request identity.** The typed tuple of observer side, connection ID,
direction, and tagged string-or-number request ID. _Avoid:_ request-ID string.

**Connection fault.** A protocol failure, defect, disconnect, or client-side
EOF that lacks a request ID and is therefore connection-scoped. Server-side EOF
is a transport fact, not a fault: it only reports that the client will send no
more messages while responses are still servable.

**Uncertain record.** An active record whose completion cannot be honestly
known after a connection fault, active-retention expiry, or observation gap.

**Event.** One normalized, versioned fact admitted through the ordered store
mutation boundary.

**Record.** The bounded aggregate projection of events for one request identity.

**Revision.** The monotonically increasing integer assigned once per accepted
store mutation.

**Delta.** An ordered set of record/descriptor operations transforming exactly
one revision into the next.

**Snapshot.** A self-contained bounded model at one revision.

**Reset.** A frame requiring a watch client to discard its prior revision and
adopt the immediately following Snapshot.

**Inspector group.** The package-owned, typed diagnostic `RpcGroup` exposing
snapshot, watch, and explicit clearing of explorer-owned history. It is
permanently observation-excluded.

**Pipeline telemetry.** Low-cardinality metrics and rare internal fault spans
about explorer operation, distinct from application RPC tracing.

## Structure

```text
RpcGroup
  -> Descriptor
  -> Observation inclusion

physical envelope + middleware context
  -> Observer
  -> policy resolution per Capture channel
  -> Normalization
  -> Event
  -> ordered mutation / Revision
  -> Record + Delta + Snapshot
  -> Inspector group
  -> React explorer

connection fault
  -> standalone Event
  -> Uncertain record(s)
```

The central distinction is **observe → authorize content → normalize → retain**.
Inclusion decides whether a signal exists. Policy decides whether one channel's
content may survive. Normalization decides its safe retained representation.
Retention and presentation consume only that representation.
