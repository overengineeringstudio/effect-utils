# RPC Devtools Integration Spec

This document specifies the separate RPC integration package. It builds on [requirements.md](./requirements.md) and the [ontology](../ontology.md).

## Status

Draft. These signatures are the intended integration contract, not existing package exports.

## Scope

Defines `/core`, `/react`, lifecycle-backed RPC sources, the local inspector bridge, and host composition. Does not own transport acquisition, production enablement, persistence, themes, capture policy, or generic meter scheduling.

## Dependency and ownership boundaries

```text
host enabled bootstrap -> rpc-devtools/core -> effect-rpc-observer
                                          -> effect-rpc-explorer
                                          -> meters
host enabled UI -------> rpc-devtools/react --lazy--> effect-rpc-explorer-react
                       -> devbar                    -> explorer core
                       -> meters/react
```

Traces: DT.RPC-R01–R05, DT.RPC-R10, DT.RPC-R12.

| Owner               | Responsibility                                                                                                                                | Does not own                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Host                | Raw transport, Scope, compile-time DEV guard, enable preference, panel state/persistence, every selected meter, content inset, theme ancestor | Shared lifecycle implementation               |
| effect-rpc-observer | Correlation, ordering, terminal deduplication, send evidence, bounded fan-out coordinator                                                     | Capture policy/store or meter calculation     |
| effect-rpc-explorer | Descriptors, capture/redaction/normalization, bounded inspection store, inspector handlers, capture telemetry, local client contract/adapter  | Transport decoration or dock                  |
| rpc-devtools/core   | One observer composition, RPC lifecycle meter source, configuration binding                                                                   | Transport creation, UI or production policy   |
| rpc-devtools/react  | Lazy explorer panel adapter and slot sizing                                                                                                   | Observation lifetime or shell state           |
| meters              | Scoped generic source scheduling, typed SeriesStore, shared frame clock, renderers and measurement brackets                                   | RPC domain semantics                          |
| devbar              | Shell geometry, slots, controlled panel interaction, shell theme tokens                                                                       | Sources, capture, transport, persistence      |
| explorer-react      | Revision-safe projection, record/detail views and internal scrolling                                                                          | Application RPC control or source acquisition |

Neither devbar nor explorer imports the other or integration; devbar has no meters dependency, and meters has no RPC dependency. `/core` has no React, StyleX, or browser-only initialization dependency. `/react` uses UI peers and a structural panel contract matching devbar without importing it; it dynamically imports explorer-react only on panel rendering. No package root eagerly re-exports UI. Host StyleX compilation includes the integration's styles and lazy explorer chunk. Adoption begins with the first canary host and then existing hosts; each host owns its bootstrap changes, without host identities recorded in this public contract.

## Core API

```ts
import type { Effect, Scope } from 'effect'
import type { RpcClient, RpcServer, RpcGroup, RpcMiddleware } from 'effect/rpc'
import type { SourceRegistration } from '@overeng/meters'
import type { ObserverSide, ProtocolSink, ProtocolObserver } from '@overeng/effect-rpc-observer'
import type {
  ExplorerConfig,
  ExplorerServices,
  ExplorerClient,
  ExplorerEncodedDecodersByTag,
  ExplorerTelemetryRegistrationError,
} from '@overeng/effect-rpc-explorer'

export type RpcMetric = 'requestsPerSecond' | 'inFlight' | 'errorsPerSecond' | 'durationP95'
export interface RpcMetersConfig {
  readonly id: string
  readonly metrics: readonly RpcMetric[]
  readonly windowMillis: number
  readonly maxCompletions: number
  readonly historyCapacity: number
}
export interface RpcSource {
  readonly sink: ProtocolSink
  readonly sources: readonly SourceRegistration[]
}
export declare const makeRpcSource: (
  options: RpcMetersConfig,
) => Effect.Effect<RpcSource, never, Scope.Scope>
export interface RpcDevtools {
  readonly explorer: ExplorerServices
  readonly observer: ProtocolObserver
  readonly client: ExplorerClient
  readonly sources: readonly SourceRegistration[]
  readonly decorateClientProtocol: (
    protocol: RpcClient.Protocol['Service'],
  ) => RpcClient.Protocol['Service']
  readonly decorateServerProtocol: (options: {
    readonly protocol: RpcServer.Protocol['Service']
    readonly requestObservation?: 'protocol' | 'middleware'
  }) => RpcServer.Protocol['Service']
  readonly middleware: RpcMiddleware.RpcMiddleware<never, never, never>
}
export declare const makeRpcDevtools: (options: {
  readonly group: RpcGroup.Any
  readonly config: ExplorerConfig
  readonly side: ObserverSide
  readonly encodedDecodersByTag?: ExplorerEncodedDecodersByTag
  readonly meters: RpcMetersConfig
}) => Effect.Effect<RpcDevtools, ExplorerTelemetryRegistrationError, Scope.Scope>
```

Traces: DT.RPC-R02–R07. Each selected metric gets one typed numeric Source following [meters' generic Source contract](../01-meters/spec.md), exposed together as `sources: readonly SourceRegistration[]`; source emission uses its available/unavailable sample tags, not a new RPC-specific numeric store. `historyCapacity` is a positive safe integer applied to each selected series. `windowMillis` is finite and positive, and `maxCompletions` is a positive safe integer. The host supplies all values; there is no implicit metric list. An empty list registers no meter sampling work and emits no series, while explicitly configured explorer capture can still run.

Construction sequence:

1. Acquire explorer with the supplied group/config in the host Scope.
2. Acquire RPC reducer/source with the supplied meter configuration.
3. Construct one observer with explorer's opted-in capture sink and the RPC metadata sink. Coordinator capacity uses `config.bounds.active.maxCount`; the ambient Effect clock and observer's side-specific connection identities are shared by both sinks.
4. Acquire the local inspector client bridge in that same Scope.
5. Return bound decorators and sources. Decorator use must match `side`; a side mismatch is a host construction error, never silently coerced. Server middleware is valid only for a server composition and shares this observer. The host installs it only when requesting middleware mode.

The host decorates a raw protocol once; integration does not acquire a second transport or wrap an already independently observed transport. Source collection can begin at observer construction; the meter session's scoped `start` owns publication cadence and must precede app traffic in the host bootstrap. Configuration, descriptor registration, and capture bounds remain explorer contracts.

## RPC source semantics

```text
onRequest -> active identities + request window
onTerminal -> remove active identity + bounded completion/error window
                     |
source cadence -> selected numeric/unavailable samples -> SeriesStore
onFault -> explicit loss evidence (not another request error increment)
```

Traces: DT.RPC-R03, DT.RPC-R06–R07.

| Metric              | Unit    | Definition                                                                                                                                                |
| ------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inFlight`          | count   | Canonically observed requests with no terminal yet; notifications remain active until their actual completion evidence                                    |
| `requestsPerSecond` | count/s | Request starts in trailing `windowMillis`, divided by the full configured window seconds                                                                  |
| `errorsPerSecond`   | count/s | Terminals classified typedFailure, defect, or transportFailure in trailing window, divided by window seconds; interrupted excluded                        |
| `durationP95`       | s       | Nearest-rank p95 (`ceil(0.95*n)-1`) of successful non-notification request durations completing within trailing window; no completions yields unavailable |

Duration includes the request's observed send/receive-to-terminal lifetime; it is not a server execution-only duration or explorer normalization duration. Successful notifications are transport/handler acceptance evidence and are excluded from response-latency statistics. Failed requests are represented in errors, not silently mixed into successful latency. Windows use monotonic timestamps; wall time is display context only. Streams contribute one request and terminal duration, not one request per chunk. Duplicate terminals and connection fault callbacks cannot decrement active counts twice or double-count errors. Canonical observer capacity loss contributes one transport-failed terminal per affected request and explicit overflow evidence.

Source ID is the host's nonempty opaque `id`. Selected series IDs are `${id}.${metric}`; metrics are closed case-sensitive repository API identifiers, not wire names. Host must prevent IDs colliding across sources. Valid example: `rpc.inFlight`; invalid metric: `inflight`. Unknown metrics are configuration errors, not silently omitted. The source declares event cadence, with a scoped expiration wake-up for trailing-window changes even when transport is idle; it acquires/releases that scheduling through the generic Source contract. No default extra frame clock is created.

Bound completion evidence by both window age and `maxCompletions`; maintain bounded request-rate evidence as well, using the same explicit capacity budget and exposing truncation instead of unbounded timestamp accumulation. Eviction of events still inside a window marks affected rate/percentile samples unavailable with a capacity-loss reason until exact coverage returns. Active gauge accounting remains exact because the observer terminalizes capacity losses. Per-series history capacity and overflow evidence are supplied through the meter store; source window loss is distinct from history overwrite. Snapshot/strip/headless readers do not drain reducer state.

## Explorer client bridge

```ts
// Defined in explorer core; integration consumes, rather than duplicates, these contracts.
export interface ExplorerWatchCursor {
  readonly afterRevision?: number
  readonly descriptorRevision?: number
}
export interface ExplorerClient {
  readonly getSnapshot: () => Promise<unknown>
  readonly watch: (cursor: ExplorerWatchCursor) => AsyncIterable<unknown>
  readonly clearHistory: () => Promise<unknown>
}
export declare const makeExplorerClient: (options: {
  readonly inspector: ExplorerServices['inspector']
}) => Effect.Effect<ExplorerClient, never, Scope.Scope>
```

Traces: DT.RPC-R05, DT.RPC-R08. The existing structural UI client contracts move to explorer core and callers import them there; remove explorer-react's duplicate client-type exports without aliases. The `unknown` boundary preserves the current UI decoder's runtime validation rather than claiming already-validated frames.

The local adapter invokes inspector handlers in-process and yields decoded wire frames, preserving revision cursors, reset frames, descriptor revisions, and overflow signals exactly. It never goes through the application's decorated transport and therefore cannot inspect its own Snapshot/Watch/ClearHistory traffic. Each watch iterator owns one scoped subscription; `return`, cancellation, projection unmount, and enclosing Scope close release it. Pending operations after release cannot publish to a closed projection. Clear history affects explorer diagnostic retention only, not RPC reducer active state, cumulative source counters, or the host transport. Remote standalone clients remain supported through the same structural contract.

## React panel adapter

```ts
import type * as React from 'react'
import type {
  ExplorerInitialFilters,
  RpcExplorerPresentation,
} from '@overeng/effect-rpc-explorer-react'
import type { TraceHref } from '@overeng/effect-rpc-explorer-react'

export interface RpcExplorerPanel {
  readonly id: string
  readonly label: string
  readonly badge?: React.ReactNode
  readonly render: () => React.ReactNode
}

export declare const rpcExplorerPanel: (options: {
  readonly client: ExplorerClient
  readonly id: string
  readonly label: string
  readonly badge?: React.ReactNode
  readonly initialFilters?: ExplorerInitialFilters
  readonly presentation?: RpcExplorerPresentation
  readonly traceHref?: TraceHref
}) => RpcExplorerPanel
```

Traces: DT.RPC-R01, DT.RPC-R09–R10. The factory returns a stable host panel descriptor; call outside repeated renders or memoize by actual inputs. Its `render` mounts a shared `React.lazy(() => import('@overeng/effect-rpc-explorer-react'))` adapter under Suspense and a labelled loading fallback. Import rejection surfaces as an explicit host error-boundary state, not fabricated explorer data.

The adapter passes existing `RpcExplorer` props unchanged except for a final panel-fitting presentation style: `height: 100%`, `min-height: 0`, `min-width: 0`, and flex growth. Caller style cannot restore the standalone fixed height; apply slot-sizing styles last. The shell owns panel dimensions, explorer owns internal table/detail overflow. Standalone `<RpcExplorer>` retains its original dimensions. No theme, persistence, enable flag, auto-mount, default meter, or dock is added. Panel close releases only projection/watch UI; observation and meter collection remain scoped to enabled diagnostics.

## Host integration

```text
host application Scope
├─ raw transport
├─ enabled-only tools + meter session lease
├─ application RPC client with one decorated protocol
└─ enabled-only UI mount (release unmounts)
```

Traces: DT.RPC-R02–R05, DT.RPC-R10–R11. The bootstrap below uses existing host `AppRpc`, raw transport provision, runtime, and capture configuration; all diagnostic runtime imports are inside the compile-time DEV branch. Type-only imports are erased.

```ts
import { Effect } from 'effect'
import { RpcClient } from 'effect/rpc'

const enabled =
  import.meta.env.DEV &&
  typeof window !== 'undefined' &&
  (() => {
    try {
      return localStorage.getItem('host.devtools.enabled') !== 'false'
    } catch {
      return true
    }
  })()

const application = Effect.gen(function* () {
  const raw = yield* RpcClient.Protocol
  if (!enabled) return yield* RpcClient.make(AppRpc)

  const { makeRpcDevtools } = yield* Effect.promise(() => import('@overeng/rpc-devtools/core'))
  const { makeMeters } = yield* Effect.promise(() => import('@overeng/meters'))
  const tools = yield* makeRpcDevtools({
    group: AppRpc,
    config: hostExplorerConfig,
    side: 'client',
    meters: {
      id: 'rpc',
      metrics: ['inFlight', 'durationP95', 'errorsPerSecond'],
      windowMillis: 1000,
      maxCompletions: 512,
      historyCapacity: 2048,
    },
  })
  const meters = makeMeters({ sources: tools.sources, platform: hostMetersPlatform })
  yield* meters.start
  const client = yield* RpcClient.make(AppRpc).pipe(
    Effect.provideService(RpcClient.Protocol, tools.decorateClientProtocol(raw)),
  )
  const { mountDiagnostics } = yield* Effect.promise(() => import('./host-diagnostics.tsx'))
  yield* Effect.acquireRelease(
    Effect.sync(() => mountDiagnostics({ tools, meters })),
    (unmount) => Effect.sync(unmount),
  )
  return client
})
```

The host runs `application` in its long-lived application scope. Do not return the client from `Effect.scoped(application)` after releasing its transport/tools. `hostMetersPlatform` is the host browser platform adapter specified by meters; no platform object is constructed in the disabled branch.

The enabled-only UI module imports devbar, meters/react, and rpc-devtools/react. Its composition is:

```tsx
const rpcPanel = rpcExplorerPanel({ client: tools.client, id: 'rpc', label: 'RPC' })
const HostDiagnostics = () => {
  const [openPanel, setOpenPanel] = React.useState<string | undefined>(undefined)
  const [selectedMeter, setSelectedMeter] = React.useState<string | undefined>(hostBlocks[0]?.id)
  const [frozen, setFrozen] = React.useState(false)
  return (
    <Devbar
      panels={[
        rpcPanel,
        {
          id: 'meters',
          label: 'Meters',
          render: () => (
            <MetersPanel
              blocks={hostBlocks}
              theme={hostMeterTheme}
              selected={selectedMeter}
              onSelect={({ id }) => setSelectedMeter(id)}
              renderDetail={renderHostMeterDetail}
            />
          ),
        },
      ]}
      openPanel={openPanel}
      onOpenPanelChange={setOpenPanel}
      strip={
        <MeterStrip
          meters={meters}
          blocks={hostBlocks}
          theme={hostMeterTheme}
          frozen={frozen}
          onFrozenChange={setFrozen}
          onOpenDetail={({ id }) => {
            if (id.startsWith('rpc.') === true) {
              setOpenPanel('rpc')
            } else {
              setSelectedMeter(id)
              setOpenPanel('meters')
            }
          }}
        />
      }
      segments={hostSegments}
    />
  )
}
```

`hostBlocks` explicitly binds generic host meters and the selected `rpc.inFlight`, `rpc.durationP95`, and `rpc.errorsPerSecond` series using meters' block contract; it is not a default preset. `renderHostMeterDetail` supplies the host's per-meter detail content. The composition has three bottom-row controls: Dev tools, RPC, and Meters. The Meters panel lists all blocks, including RPC readings; only strip activation of `rpc.*` routes directly to RPC. Focus alone does not open a panel, while Enter/Space and click follow the same activation path.

The host-composition story persists `openPanel` as an opaque string under its existing light/dark-specific panel storage key and the selected meter under `${storageKey}.meter`. An unknown stored meter falls back to the first supplied block; an empty block list leaves selection undefined. A stored per-meter panel ID from the previous composition opens Meters and supplies its selection when no separate meter preference exists. Unknown panel IDs render closed. Closing Meters removes only the open-panel preference, preserving the meter for reopening. Storage denial falls back to working in-memory state. The shell, RPC adapter, and `MetersPanel` own none of this persistence.

The host's mount function creates the DOM root, mounts this component under its theme ancestor, and returns a function that unmounts the React root and removes its node. It must not acquire a second session lease via a provider when bootstrap already owns `meters.start`. Host segments may contain real WebSocket/sync status without moving that domain into RPC integration. Freeze remains host-controlled and renderer-only; no package persists it automatically.

Disabling ends the diagnostic/application transport boundary and recreates an undecorated client transport; re-enabling recreates the decorated one. Hiding the panel is not disablement, and a disabled session cannot recover unobserved history retroactively.

## Conformance

| Fixture                      | Required evidence                                                                                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One raw transport, two sinks | exactly one request/chunk/terminal delivery per sink; no second decoration; metadata sink receives no values                                                                 |
| RPC event replay             | balanced active gauge; stream, notification, interruption, send failure, fault, dedup, window expiry, bounded capacity loss and percentile semantics                         |
| Bridge                       | matching snapshot/watch/clear frames, revision/reset correctness, iterator return cancellation, scope teardown, no self-observed inspector calls                             |
| Panel                        | lazy load occurs on open only; fills available slot; internal scroll; standalone dimensions unchanged; close stops watch but not collection                                  |
| Host composition             | exactly Dev tools/RPC/Meters row controls; strip click/Enter selects Meters detail except `rpc.*`; all meters reachable in panel; restored selection and unknown-ID fallback |
| Disabled host fixture        | no loader, constructor, source start, observer/metric/tracer/protocol hook, timer, frame callback, listener, or UI mount                                                     |
| Production graph             | no reachable diagnostic module, chunk, or dynamic-import reference                                                                                                           |
| Rebuild fixture              | old watches/sources/coordinator released; raw protocol restored when off; one observation installation when on                                                               |

Traces: DT.RPC-R01–R11. Tests use real lifecycle fixtures and injected clocks; unsupported/empty evidence remains explicit unavailable. They must not infer request latency from normalization telemetry or substitute synthetic zero values.
