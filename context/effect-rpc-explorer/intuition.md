# Effect RPC Explorer Intuition

_For: host integrators and package implementers · Assumes: Effect RPC group,
middleware, and Protocol vocabulary · Covers: the explorer's safety and
lifecycle model._

An RPC explorer answers a narrow question: **what is this process doing over
RPC right now, and what safely retained evidence explains it?** It is not an
RPC controller, log sink, or substitute tracer.

```text
Application RPC traffic
      |
      +-- shared observer middleware: decoded context and handler result
      +-- shared observer Protocol: actual messages and send/control evidence
      |
      v
  one scoped coordinator -> explorer capture sink
  include? ---- no ---> no explorer work
      |
     yes
      v
  each content channel: omit / reveal / redact
      |
      v
  detached normalized event
      |
      v
  bounded live records  ---> typed snapshot/watch ---> React inspector
```

The shared observer joins two complementary seams on one scoped coordinator.
Middleware knows decoded payloads and the handler's terminal Cause; Protocol
knows chunks, Ack/Interrupt, actual sends, and transport faults. Explorer's
capture sink receives that canonical lifecycle plus borrowed raw values and
envelopes. It does not implement another transport wrapper or coordinator.

The explorer is safe only if it makes its privacy decision before storage. It
does not keep raw values and hide them later. Every one of seven channels has
its own policy, defaulting to omission. If a host deliberately reveals or
redacts content, the core replaces runtime values with a detached, bounded
value tree. A Redacted wrapper is not safe to retain merely because it looks
masked: it still owns a backing value, so the explorer turns it into an
irreversible placeholder.

The observed object is a **logical RPC**, described once from the host's
`RpcGroup`. A transport may hide that RPC inside a shared envelope; in that
case, the host maps the envelope to an existing descriptor. The UI never
reconstructs schemas from raw traffic. This keeps a stream's element/error
schemas, policy roots, and rendered descriptor in agreement.

RPC traffic is asynchronous, so the explorer calls uncertainty by name. A
request ID is only meaningful beside its connection, direction, observer side,
and original string-or-number type. A connection-level fault is not secretly
attributed to the most recent call: it becomes a connection fault and every
active related record becomes uncertain. Stream chunks count both envelopes and
values because a batch is one wire message but potentially many outputs.

The model has no persistence and must stay bounded. A single ordered mutation
turns a safe event into records, evicts old state, assigns a revision, and
publishes a delta. A Watch without a prior revision starts with a snapshot; a
resuming Watch receives either a contiguous replay or a reset plus snapshot, so
a UI does not have to guess whether it missed a live event. Clearing diagnostic
history removes completed explorer history while preserving active records and
likewise resets watchers. The inspector group itself is excluded from
observation; otherwise asking what the explorer sees would recursively create
more traffic to see.

Finally, tracing already owns per-call spans. The explorer copies available
trace IDs into its records and reports only its own small, low-cardinality
pipeline health. It does not compete with application spans or turn payloads
into telemetry attributes. The UI is therefore a calm, dense lens over the
same bounded model: it makes omission, truncation, uncertainty, and policy
faults legible rather than filling gaps with plausible fiction.
