# Effect RPC Explorer Requirements

## Context

These requirements define a reusable, embedded explorer for observing live
Effect 4 RPC systems. The explorer is a diagnostic projection inside the host
process, not a collector or an RPC runtime.

The normative subsystems refine this contract:

- [01-core](./01-core/requirements.md) defines capture, correlation, policy,
  retention, descriptors, and the inspector protocol.
- [02-react-ui](./02-react-ui/requirements.md) defines the accessible React
  inspection surface.

Canonical terms are defined in [ontology.md](./ontology.md).

## Assumptions

- **RPCX-A01 Effect 4 surface:** The supported integration surface is the public
  `effect/unstable/rpc` API. It is version-unstable even though it is publicly
  exported.
- **RPCX-A02 Host composition:** A host supplies its `RpcGroup` values,
  client/server Protocol services, service identity, and explicit explorer
  configuration at its composition boundary.
- **RPCX-A03 Trusted policy code:** Capture-policy transforms are trusted host
  code. The explorer can enforce storage ordering and fail-closed behavior, but
  cannot prove an arbitrary transform removes every secret.
- **RPCX-A04 Same-process schema authority:** Live Effect schemas remain the
  decoding authority. JSON Schema is only a best-effort serializable
  projection.

## Acceptable Tradeoffs

- **RPCX-T01 Bounded history:** Old completed records, old active observations,
  and excess value content may be evicted or truncated with explicit evidence.
- **RPCX-T02 Secure silence:** Missing or faulty capture policy loses content
  rather than risking disclosure.
- **RPCX-T03 Unstable dependency:** Effect RC upgrades may require a small
  adapter change and rerunning compatibility evidence.
- **RPCX-T04 Diagnostic overhead:** Enabling the explorer adds bounded capture,
  normalization, and rendering work; disabled integrations may be inert.
- **RPCX-T05 Connection-level uncertainty:** Protocol faults lacking a request
  ID remain connection-scoped and may make several active requests uncertain.

## Requirements

### Must be reusable and embedded

- **RPCX-R01 Embedded live projection:** The explorer must inspect the host's
  current RPC traffic in process without requiring an external collector,
  durable database, or background ingestion service.
- **RPCX-R02 Diagnostic-only control:** The explorer must not invoke, replay,
  retry, cancel, or mutate application RPCs. Its inspector API may clear only
  completed explorer history, obsolete replay data, and events no longer
  referenced by an active record; it must preserve active request records and
  must not clear application state or alter in-flight RPC behavior.
- **RPCX-R03 Package separation:** Transport-agnostic capture and inspection
  must be provided by `@overeng/effect-rpc-explorer`; the React surface must be
  provided separately by `@overeng/effect-rpc-explorer-react`.
- **RPCX-R04 Host neutrality:** Public contracts, defaults, examples, and UI
  must not depend on one application's names, transports, paths, or data.

### Must observe the complete public lifecycle honestly

- **RPCX-R05 Complete lifecycle:** Observation must cover decoded request
  context and terminal handler cause plus encoded Request, Chunk batch, Ack,
  Interrupt, Exit, send attempt/result, disconnect, and connection-fault
  signals available through supported Effect 4 seams.
- **RPCX-R06 Public seams only:** Capture must use `RpcMiddleware` and decorators
  around public client/server Protocol services, forwarding every Protocol
  capability unchanged; it must not import private implementation files or
  rely on APIs marked internal.
- **RPCX-R07 Typed request identity:** Correlation must preserve connection,
  direction, observer side, and the original string-or-number request-ID type.
  It must not correlate through string coercion or across connections.
- **RPCX-R08 Honest uncertainty:** Notifications, transport-send failures,
  disconnects, uncorrelated protocol faults, observation gaps, and retention
  eviction must have explicit semantics and must not be presented as ordinary
  successful or failed application calls.
- **RPCX-R09 Normalized typed records:** Every observed signal must become a
  versioned typed event and aggregate record with deterministic state
  transitions, distinct chunk-envelope and stream-value counts, and no
  transport-specific object retained as model authority.

### Must describe RPCs from one authority

- **RPCX-R10 Descriptor authority:** RPC descriptors must originate from the
  supplied `RpcGroup`; a host may explicitly map a physical envelope to one
  logical RPC descriptor when transport multiplexing hides the schema. Capture
  and UI must consume that same descriptor projection.
- **RPCX-R11 Schema fidelity:** Descriptors must distinguish unary and streaming
  RPCs and expose payload, success, typed failure, defect, stream element, and
  stream error schemas through public Effect APIs. Serializable JSON Schema
  must be labeled best-effort rather than authoritative.

### Must make capture safe by construction

- **RPCX-R12 Seven independent channels:** Capture policy must independently
  govern `requestPayload`, `success`, `typedFailure`, `defect`, `streamElement`,
  `streamError`, and `headers`.
- **RPCX-R13 Deterministic precedence:** Each channel must resolve exactly one
  whole-channel `omit`, `reveal`, or `redact` policy with precedence host
  override, then RPC annotation, then that channel's root Schema annotation,
  then package default `omit`.
- **RPCX-R14 No raw storage:** Policy must be resolved and applied before event
  construction or insertion. `omit` must store no content field; `redact` must
  store only a detached normalized transform result; policy or normalization
  failure must fail closed to omission with content-free evidence.
- **RPCX-R15 Redacted normalization:** Any `Redacted` value encountered during
  normalization must become an irreversible placeholder in the retained model.
  The explorer must never retain its wrapper or backing value and must not use
  permissive Schema JSON encoding as a sanitizer.
- **RPCX-R16 Observation inclusion:** Whether an RPC is observed must be a
  separate annotation from content capture. The explorer's typed inspector
  group must be excluded, and observation must not recurse through its own
  snapshot, watch, or clear-history traffic.

### Must remain bounded and race-free

- **RPCX-R17 Bounded retention:** Completed records, active observations,
  retained stream values, individual normalized values, and replayable deltas
  must each have explicit count, age, or byte bounds. Eviction and truncation
  must be observable without retaining discarded content.
- **RPCX-R18 Atomic snapshot/watch:** The inspector protocol must provide typed
  NDJSON snapshot plus monotonically increasing revision and ordered delta
  frames with a subscription handshake that neither loses nor duplicates a
  mutation between snapshot and live watch.
- **RPCX-R19 Single-writer consistency:** State transitions, retention, snapshot
  creation, and delta publication must share one ordered mutation boundary so
  readers never observe a revision/model mismatch.
- **RPCX-R20 Ephemeral operation:** Restarting the host may lose all explorer
  state. The package must not own persistence, upload, or collector export.

### Must integrate with telemetry without duplicating it

- **RPCX-R21 Trace correlation:** Records must carry available trace and span
  identifiers as typed fields. The explorer must use the host's service
  resource identity and must not create a second service identity.
- **RPCX-R22 No per-call spans:** The explorer must not emit a span for each RPC
  call because the Effect RPC runtime already owns call spans. Rare explorer
  pipeline-fault spans may link to, but must not parent or replace, application
  traces.
- **RPCX-R23 Low-cardinality metrics:** Explorer metrics must describe pipeline
  events, drops, retention, active counts, and normalization latency using
  bounded attributes. Telemetry must contain no payloads, headers, paths,
  request IDs, RPC tags, or other user-controlled content.

### Must provide an effective inspection UI

- **RPCX-R24 Dense live inspection:** The React package must present live active
  and completed calls, lifecycle/status, timings, stream counts, faults,
  descriptors, and policy outcomes with filtering and inspectable detail.
- **RPCX-R25 Accessible interaction:** All explorer functions must be usable by
  keyboard and assistive technology, preserve focus through live updates, avoid
  color-only status, and remain usable at narrow and wide widths.
- **RPCX-R26 UI implementation boundary:** The UI must use React Aria for
  interactive semantics, StyleX for styling/tokens, and only the typed core
  client/model contract rather than transport envelopes or Effect RPC internals.
- **RPCX-R27 Storybook evidence:** Deterministic Storybook stories must cover
  principal lifecycle, policy, empty/loading, overflow/truncation, fault,
  accessibility, and responsive states; a live in-memory story must demonstrate
  snapshot-to-delta updates without observing itself.

### Must be verifiable across boundaries

- **RPCX-R28 Focused proof:** Verification must include lifecycle/state unit
  tests, policy/storage security tests, protocol race tests, telemetry tests,
  accessible Storybook interaction checks, and descriptor/schema tests.
- **RPCX-R29 Transport verification:** The shared in-memory public-seam
  conformance suite must cover unary success, typed failure, stream batch/Ack,
  cancellation, send failure, and connection fault against the generic contract.
  Each adopter must run one focused real-transport smoke for its selected
  integration without changing that contract.
- **RPCX-R30 Upgrade evidence:** Each supported Effect version change must
  compile the public-seam adapter and rerun the disposable compatibility probes
  before support is claimed.
