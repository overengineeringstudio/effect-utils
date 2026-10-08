# Effect RPC Observer Requirements

## Context

`@overeng/effect-rpc-observer` owns transport-neutral lifecycle observation for the [devtools stack](../spec.md), using the shared [ontology](../ontology.md). [Explorer core](../../effect-rpc-explorer/01-core/spec.md) owns content policy and inspection; [RPC integration](../04-rpc-devtools/spec.md) composes consumers.

This subsystem implements Q9: public content-free shared observation, lifecycle sinks, optional transient raw attachment, one-decoration fan-out, and explorer clean cutover. Q12–Q13 constrain integration independence and transport-scope enabling.

## Assumptions

- **DT.OBS-A01 Public seams:** Host protocols implement the public Effect RPC client/server Protocol services, including transferables and server capability fields.
- **DT.OBS-A02 Host identities:** Hosts provide distinct connection identities for distinct transport lifetimes; request IDs retain their wire string/number distinction.

## Acceptable Tradeoffs

- **DT.OBS-T01 Bounded deduplication:** Terminal tombstones are bounded; duplicates older than the declared retention cannot be reconstructed as new lifecycle events without a new request.
- **DT.OBS-T02 Best-effort sinks:** Sink exceptions are isolated from transport behavior and other sinks; the observer cannot guarantee a failing sink consumed an event.

## Requirements

### Must separate lifecycle from content

- **DT.OBS-R01 Package boundary:** The observer must have no explorer store, capture/redaction/normalization policy, meters, React, or UI dependency. Default lifecycle events must contain no payload, headers, response values, or fault content. Implements Q9.
- **DT.OBS-R02 Sink contract:** The package must expose `onRequest`, `onChunk`, `onTerminal`, and `onFault`, with correlated identity, ordering, timestamps, and a terminal outcome suitable for balanced in-flight accounting. Implements Q9.
- **DT.OBS-R03 Raw attachment:** Only individually opted-in sinks may receive transient encoded/decoded raw attachments and raw control/send envelopes. Metadata-only registrations must receive none; the observer must not clone, normalize, or retain raw content. Implements Q9.
- **DT.OBS-R04 Fan-out:** One transport decoration must fan each canonical event to all registered sinks in deterministic registration order. Sink failure must not change transport channels or prevent another sink from observing. Implements Q9.

### Must preserve transport and lifecycle truth

- **DT.OBS-R05 Protocol preservation:** Client and server decoration must preserve public capabilities, original messages, callbacks, transferables, success/error/interruption channels, and send semantics.
- **DT.OBS-R06 Correlation:** Correlation must distinguish observer side, connection, request direction, and typed request ID. Chunks/terminals must never create phantom requests or cross connections.
- **DT.OBS-R07 Ordering and deduplication:** Requests must precede their chunks/terminal; each observed request must terminalize at most once. Protocol and decoded middleware seams must share one coordinator rather than double-counting lifecycle events.
- **DT.OBS-R08 Send evidence:** Send attempts, completion, notification success, and send failures must reflect actual transport execution. Failed sends must settle affected active accounting; an attempted send must not be reported as successful delivery.
- **DT.OBS-R09 Interruption and faults:** Interrupt envelopes must not imply completion before terminal evidence; terminal interruption must be distinguishable from request error. Disconnect/fault/capacity loss must settle affected active requests explicitly. Server inbound EOF must not terminalize requests still serviceable by the transport.
- **DT.OBS-R10 Bounded scope:** Correlation and deduplication state must be bounded and scoped, with explicit capacity overflow. Releasing observation must remove owned subscriptions and references; enabling/disabling must rebuild the host transport scope. Implements Q12–Q13.

### Must replace explorer-owned observation

- **DT.OBS-R11 Clean cutover:** Explorer must depend on this package and expose a capture sink, not its own transport observer/decorator/middleware exports or `ExplorerServices` decoration methods. All standalone and integrated callers must migrate without compatibility shims. Implements Q9.
- **DT.OBS-R12 Standalone support:** Explorer plus this observer must remain usable without devbar, meters, or RPC integration. Capture policy, store retention, telemetry, and descriptor resolution must remain explorer-owned. Implements Q9 and Q12–Q13.
