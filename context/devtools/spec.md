# Devtools Spec

This document specifies the devtools stack. It builds on
[requirements.md](./requirements.md).

Status: **Draft** — the target contract, not a claim that every package already implements it.

## Scope

This document defines system composition, package dependencies, enabling and
teardown boundaries, shared naming, and conformance evidence. Detailed contracts
belong to [meters](./01-meters/spec.md), [devbar](./02-devbar/spec.md),
[RPC observer](./03-rpc-observer/spec.md), and [RPC integration](./04-rpc-devtools/spec.md).
Capture policy and inspector semantics belong to the
[Effect RPC explorer](../effect-rpc-explorer/spec.md).

It does not define host-specific adoption code, persisted preferences,
application transports, telemetry export, or durable diagnostic storage.

## Layer Architecture

Trace: DT-R01–R04, DT-R13–R14, DT-R18–R22.

```text
Host enabling boundary: build guard + dynamic import + preference policy
  |
  +-- scoped Effect acquisition
  |     Sources (PerFrame | Interval | Event)
  |       |
  |       v
  |     SeriesStore (typed bounded rings; non-destructive reads)
  |       |
  |       +-- one shared visibility-aware FrameClock
  |       |
  |       +-- independent renderers
  |             +-- single DPR canvas strip: history + value blocks
  |             +-- accessible text + DOM tooltips
  |             +-- headless snapshots + measure brackets
  |             +-- detail-panel views
  |
  +-- devbar shell: [panel toggle + tabs] [canvas strip] [host segments]
        fixed 32px bottom bar; panel opens above without shifting the bar
```

The host supplies the exact source list, block list, panels, and segments; none
are installed by default. An enabled empty composition remains empty. Source
cadence and renderer cadence are independent. A renderer can detach or freeze
while headless measurement continues; disabling the enabling boundary closes
the diagnostic scope rather than merely hiding the canvas.

The shared frame clock is a scheduling service owned by the meters session,
not a buffer writer or a separate collector per block. See
[meters lifecycle](./01-meters/spec.md#scoped-lifecycle-and-frameclock).

## Package Graph

Trace: DT-R01, DT-R04–R07, DT-R24.

Arrows mean **imports/depends on**, not data direction; optional browser and
React adapters are separate entrypoints.

```text
host app ----------------------------> @overeng/devbar + @overeng/meters UI (fills devbar slots)

@overeng/rpc-devtools/core ---------> @overeng/meters
                  |---------------> @overeng/effect-rpc-observer
                  +---------------> @overeng/effect-rpc-explorer

@overeng/rpc-devtools/react --------> @overeng/rpc-devtools/core (types/client)
                  +-- lazy import -> @overeng/effect-rpc-explorer-react

@overeng/effect-rpc-explorer -------> @overeng/effect-rpc-observer
@overeng/effect-rpc-explorer-react -> @overeng/effect-rpc-explorer (model/client)

@overeng/meters: no RPC, devbar, or explorer dependency
@overeng/devbar: no meters, observer, rpc-devtools, or explorer dependency
@overeng/effect-rpc-observer: no meters, devbar, explorer store, or capture policy
```

| Package                              | Owns                                                                                   | Must not own                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `@overeng/meters`                    | Effect sources, shared history/clock, renderers, headless gates, typed instrumentation | RPC protocol interception, shell state, host persistence           |
| `@overeng/devbar`                    | Bar/panel layout, tabs, controlled selection, theme adapter, host slots                | Independent FPS collector, capture, preferences storage            |
| `@overeng/effect-rpc-observer`       | Correlation, ordered lifecycle events, send failure, deduplication, sink fan-out       | Store, capture policy, payload retention, UI                       |
| `@overeng/rpc-devtools`              | Shared observer composition, RPC sources, explorer client binding, lazy panel factory  | Devbar/explorer mutual dependency, application transport ownership |
| `@overeng/effect-rpc-explorer`       | Descriptors, policy-governed capture, retained model, inspector API                    | A second protocol decoration implementation                        |
| `@overeng/effect-rpc-explorer-react` | Standalone inspector presentation                                                      | Transport decoration, capture policy                               |

Meters stays public at `packages/@overeng/meters`. Its package-local historical
VRS is replaced by this cross-cutting tree; package documentation links here.
Explorer's old decoration exports are replaced by imports from the observer
package, without aliases or shims. Its middleware/capture/store responsibilities
remain explorer responsibilities. Standalone explorer composition attaches its
own sink to the same observer without requiring rpc-devtools or devbar.

## RPC Composition Seam

Trace: DT-R05–R07, DT-R12, DT-R22.

```text
host transport scope
  Protocol -> one shared observer decoration
                +-- content-free lifecycle sink -> RPC Source -> SeriesStore
                +-- explorer sink (optional transient raw messages)
                      -> capture policy -> explorer store -> client
                                                        -> lazy panel
```

The observer sink has `{ onRequest, onChunk, onTerminal, onFault }`. A single
ordered, deduplicated lifecycle fans out to N sinks. A sink's optional raw
attachment exists only for that callback invocation; explorer applies its own
capture policy before retaining anything. Meters receives no payload, header,
or result contents. Correlation and transport faults are defined once in
[03-rpc-observer](./03-rpc-observer/spec.md).

The separate integration entrypoints have this composition surface; their
concrete types are defined in [04-rpc-devtools](./04-rpc-devtools/spec.md):

```ts
// @overeng/rpc-devtools/core; no React import
makeRpcDevtools({ group, config, side, meters })
// -> { decorateClientProtocol, decorateServerProtocol, sources, client }

// @overeng/rpc-devtools/react
rpcExplorerPanel({ client, id, label })
// -> panel descriptor; lazy-loads @overeng/effect-rpc-explorer-react
//    and fills the devbar panel slot
```

The host registers the returned RPC source explicitly in its meters session
and mounts the returned panel through the shell's ordinary panel interface.
The returned decorators wrap the transport once for the selected observer side
and sinks; neither panel mount nor canvas attachment decorates a transport.
Enabling or disabling transport observation rebuilds the host's transport
scope. Closing only the explorer panel does not change observation or capture.

## Enabling, Persistence, and Lifetime

Trace: DT-R08–R12, DT-R24.

```text
absent --host DEV guard + enabled--> load module --> acquire diagnostic scope
                                                       |
                                                       +-- attach views
                                                       +-- detach/freeze views
                                                       |
          absent <-- release all diagnostic resources <-- host disable/dispose
```

The host must guard the **import expression**, not just the mounted result:

```tsx
const loadDiagnostics =
  import.meta.env.DEV === true ? () => import('./host-diagnostics.tsx') : undefined

// Host preference defaults to the development-build setting.
// No diagnostic module is referenced by the ordinary production branch.
const HostDiagnostics = () =>
  loadDiagnostics === undefined ? null : (
    <DevbarBoundary enabled={hostPreference ?? import.meta.env.DEV} load={loadDiagnostics} />
  )
```

`DevbarBoundary` is optional ergonomic glue; the contract belongs to the host.
The enabled-only module constructs sources, acquires the meters session, and
installs any host-selected tracer/transport/Profiler instrumentation. Disabled
code does not call the loader, construct source lists/runtimes, acquire a
scope, or install hooks. All imports and factories are declarative. Merely
hiding a panel is not disabling diagnostics.

Host state drives `openPanel` and `onOpenPanelChange`; storage, deep links, and
preference policy stay outside devbar. Remove devbar's internal `persist` and
`storageKey` paths. A production diagnostics build is an explicit separate host
choice, not the ordinary production default.

Meters acquisition is lease-based and serialized behind unfinished cleanup;
last-lease release synchronously deactivates browser callbacks before awaiting
asynchronous finalizers. Late app-memory probes cannot publish into a released
scope. Observation changes use fresh host transport scopes, not mutable sink
patching of an already running transport.

## Measurement and Presentation Invariants

Trace: DT-R13–R22.

| Concern              | System rule                                                                                     | Contract owner                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Unavailable evidence | Tagged samples and visible `n/a` reason; measured zero remains a number                         | [meters](./01-meters/spec.md#samples-and-series)                      |
| History              | Per-source bounded capacity; actual range and overflow; approximately 10s visual window         | [meters](./01-meters/spec.md#seriesstore-and-history)                 |
| Frame evidence       | One clock; 2s trailing statistics; calibrated buckets 60/120/144/160/240                        | [meters](./01-meters/spec.md#frame-bookkeeping)                       |
| Gates                | Complete/Incomplete with reasons; no threshold before eligibility check                         | [meters](./01-meters/spec.md#headless-snapshots-and-measure-brackets) |
| Memory               | Heap in strip; opt-in isolated application-memory probe in details; no automatic headers        | [meters](./01-meters/spec.md#built-in-sources-and-availability)       |
| Fibers               | Actual `child_fibers_active` gauge, labelled active child fibers; absent configuration is `n/a` | [meters](./01-meters/spec.md#built-in-sources-and-availability)       |
| Spans                | Existing otel-browser SpanRing/tracer seam, no second exporter or independent tracer patch      | [meters](./01-meters/spec.md#built-in-sources-and-availability)       |
| Strip                | One DPR canvas, 32px row, approximately 150px blocks, value + history                           | [meters](./01-meters/spec.md#canvas-and-independent-renderers)        |
| Interaction          | Click/focus opens details; separate freeze; keyboard tooltip; no hover-only action              | [devbar](./02-devbar/spec.md)                                         |
| Status               | Host owns WebSocket/sync segment and existing connection; no diagnostic socket                  | [devbar](./02-devbar/spec.md)                                         |
| Theme                | Semantic tokens across light/dark; no StyleX dependency in meters                               | [meters](./01-meters/spec.md#canvas-and-independent-renderers)        |

## Naming Contract

Trace: DT-R03, DT-R14, DT-R24.

The public npm namespace `@overeng` is owned by the package publisher. Within
a session, source, series, instrument, block, panel, and segment identifiers
are **repository/host-local identifiers**, not wire-protocol standards. They
are nonempty, case-sensitive strings without whitespace or control characters;
`frame`, `heap`, `host.pendingJobs`, and `rpc.client.latency` are valid examples;
empty strings and `heap bytes` are invalid. Hosts choose their own prefix when
combining independently authored definitions. Duplicate identifiers in the
same kind/session fail before acquisition; they do not silently overwrite.

IDs identify objects, labels are display text, and units describe values;
changing a label never changes identity. Source and series IDs may coincide
for a one-series source but are not independent type discriminators.
`_tag` discriminates a single semantic axis (sample kind, cadence, measurement
completeness). An unknown tag at a serialization/test-bridge boundary is a
decode error, never a healthy fallback. Bridges preserve typed identities and
validate handles; these IDs do not establish a new global registry or durable
wire format. RPC request identity and protocol keys follow the separate
[observer naming contract](./03-rpc-observer/spec.md), and explorer inspector
identifiers follow its own specification.

## Conformance Evidence

Trace: DT-R23.

| Evidence                           | Required assertion                                                                                                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Disabled boundary in StrictMode    | Loader/runtime acquisition/rAF/timer/observer/listener/metric enablement/tracer/protocol/Profiler start counters all remain zero; unrelated host telemetry remains untouched             |
| Ordinary production fixture output | No meters/devbar/integration diagnostic modules, chunks, or dynamic-import references in the emitted graph                                                                               |
| Enabled lifecycle                  | Toggle off, unmount, and HMR disposal restore diagnostic resources to baseline; late probe results publish nothing; repeated acquisition has peak one collector per source and one clock |
| Multiple readers                   | Two strips, text, and headless consumers share evidence without additional collectors, destructive reads, or reader-dependent cadence                                                    |
| Deterministic frame tests          | Supported calibration buckets, bucket changes, missed frames, hidden/resume gaps, 2s statistics, and cumulative bracket deltas                                                           |
| Capability tests                   | Missing memory APIs, non-isolated probes, disabled runtime metrics, unconfigured tracer/RPC/Profiler, and absent jank APIs all yield explicit unavailable evidence                       |
| History and gates                  | Capacities and overflow visible; counters independent of ring eviction; incomplete/hidden/calibration-invalid measurements cannot pass gates                                             |
| Interaction and rendering          | DPR sizing, history/value parity with accessible outputs, light/dark themes, focus detail opening, keyboard tooltips, separate freeze, stationary bar                                    |
| RPC fan-out                        | One decoration with multiple sinks; ordering, deduplication, send-failure/fault semantics; explorer capture independent from content-free meters                                         |

These are implementation acceptance criteria, not a report that checks were run.

## Decision Trace

Decision labels identify the agreed contract without encoding a date or a task plan.

| Decision                                            | Normative destination                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------ |
| Q1 Canvas live meters                               | DT-R18; Layer Architecture; meters Canvas and Independent Renderers            |
| Q2 Public meters composed by devbar                 | DT-R01; Package Graph                                                          |
| Q3 Effect source/store/renderer split and removals  | DT-R02, R14, R24; Layer Architecture; meters lifecycle and migration           |
| Q4 Host-owned canary adoption                       | DT-T04                                                                         |
| Q5 Explicit host selection                          | DT-R03; Layer Architecture                                                     |
| Q6 Heap versus opt-in isolated memory               | DT-R16; Measurement and Presentation Invariants; meters built-ins              |
| Q7 Details versus freeze, keyboard tooltip          | DT-R20; Measurement and Presentation Invariants                                |
| Q8 Active child fibers and unconfigured n/a         | DT-R17; meters built-ins                                                       |
| Q9 Shared content-free observer                     | DT-R05–R06; Package Graph; RPC Composition Seam                                |
| Q10 Source capacity, 2s statistics, ~10s history    | DT-R14; Measurement and Presentation Invariants; meters history/frame sections |
| Q11 Complete/Incomplete gates                       | DT-R15; meters Headless Snapshots and Measure Brackets                         |
| Q12 Separate headless integration                   | DT-R04, R07; Package Graph; RPC Composition Seam                               |
| Q13 Lazy explorer panel and transport-scope rebuild | DT-R07, R12; RPC Composition Seam; Enabling, Persistence, and Lifetime         |

## Open Design Questions

None. The package implementation may lag this draft contract; implementation
status is not a normative design question.
