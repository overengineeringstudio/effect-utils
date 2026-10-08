# Devtools Requirements

## Context

This contract builds on [vision.md](./vision.md). The implementation blueprint is
[spec.md](./spec.md); shared language is defined in [ontology.md](./ontology.md).

Subsystem contracts:

- [01-meters](./01-meters/requirements.md): acquisition, typed history, renderers, and measurement gates.
- [02-devbar](./02-devbar/requirements.md): the development shell and controlled interaction.
- [03-rpc-observer](./03-rpc-observer/requirements.md): shared transport lifecycle observation.
- [04-rpc-devtools](./04-rpc-devtools/requirements.md): RPC meter/explorer integration.

The existing [Effect RPC explorer](../effect-rpc-explorer/requirements.md) owns
capture policy, retention, and request inspection; this contract defines its
shared observation seam and composition with meters.

## Assumptions

- **DT-A01 Browser host:** Live browser diagnostics run in a browser-like host; deterministic storage and headless interfaces can be exercised with injected platform capabilities.
- **DT-A02 Explicit composition:** A host owns its application runtime, transport scopes, instrumentation, build-time enabling boundary, and diagnostic preferences.
- **DT-A03 Shared public workspace:** The packages are reusable public packages in this repository; examples and contracts use neutral host terminology.

## Acceptable Tradeoffs

- **DT-T01 Enabled overhead:** Enabled diagnostics perform bounded observation and rendering work. Capability-specific sampling can sacrifice breadth for low overhead, but cannot fabricate evidence.
- **DT-T02 Bounded history:** Retention is finite and source-specific; old evidence may be evicted when loss and the retained range are exposed.
- **DT-T03 Platform variation:** A browser may provide fewer signals than another browser. Explicit `n/a` is preferable to an inferred substitute.
- **DT-T04 Host-owned rollout:** Hosts can adopt independently. The adoption sequence is a first canary host under active web-app development, then a second wave of existing hosts; no package silently enables other hosts.

## Requirements

### Must have clean, composable boundaries

- **DT-R01 Public meters:** `@overeng/meters` must live publicly at `packages/@overeng/meters` and remain independently usable without a devbar or explorer.
- **DT-R02 Independent layers:** Source acquisition, typed history, rendering, and the devbar shell must be separately composable. Attaching a renderer must not create another source collector.
- **DT-R03 Explicit selection:** A host must choose every source and displayed meter explicitly. There must be no automatically installed or displayed default meter set.
- **DT-R04 Package independence:** Meters must have no RPC dependency. Devbar and explorer must never import one another. RPC integration must reside in the separate `@overeng/rpc-devtools` package.
- **DT-R05 Shared RPC observation:** One `@overeng/effect-rpc-observer` transport decoration must support multiple lifecycle sinks without duplicate interception; explorer must consume that package rather than retain its own decoration exports or compatibility shims.
- **DT-R06 Observer policy separation:** The shared observer must retain no inspection store and define no capture policy. Content-free lifecycle metadata must suffice for meters; raw-message delivery must be transient and optional per sink for explorer capture.
- **DT-R07 Headless integration:** RPC meter acquisition and inspector clients must be usable without importing React or the explorer UI; standalone explorer use must remain supported.

### Must impose no disabled runtime or delivery cost

- **DT-R08 Development boundary:** Host integration must default to enabled in development builds and disabled in ordinary production builds. The host owns the enabling boundary and the guarded dynamic import.
- **DT-R09 Disabled means absent:** A disabled integration must not load its diagnostic module, construct a runtime, start animation frames or timers, install observers/listeners, enable metrics, or register tracer/protocol/Profiler hooks. The ordinary production output must exclude diagnostic modules, chunks, and diagnostic dynamic-import references.
- **DT-R10 Declarative imports:** Importing a diagnostic package or constructing a source/session definition must start no collector, browser subscription, metric enablement, or background task.
- **DT-R11 Scoped release:** Disabling or disposing diagnostics must release diagnostic resources and prevent late asynchronous results from publishing. Repeated enable/disable and React StrictMode rehearsal must not overlap collector installations.
- **DT-R12 Host control:** Persistence and open-panel state must belong to the host; devbar must expose controlled `openPanel`/`onOpenPanelChange` rather than internal storage. Changing transport observation must require rebuilding the host's transport scope, not silently patching a live transport.

### Must present real, shared evidence

- **DT-R13 Honest availability:** Unsupported, unconfigured, hidden, failed, and incomplete measurements must be distinguishable from measured zero. No warmup value or fallback may masquerade as a real reading.
- **DT-R14 Shared evidence:** Visual, accessible-text, detail, and headless consumers must read the same non-destructive typed history and cumulative instrumentation. Histories must expose capacity, retained time range, and overflow.
- **DT-R15 Gate eligibility:** `endMeasure` must return tagged `Complete | Incomplete` outcomes with reasons for incomplete evidence. Performance gates must check completeness and relevant capability eligibility before applying numeric thresholds.
- **DT-R16 Safe memory probes:** The strip must distinguish approximate `performance.memory` heap from opt-in application-memory probing. The latter must require cross-origin isolation and must never cause automatic COOP/COEP changes.
- **DT-R17 Honest fibers:** A fibers meter must display the Effect `child_fibers_active` runtime gauge as **active child fibers**, and show `n/a`, not zero, until the host enables runtime metrics.

### Must provide an accessible embedded surface

- **DT-R18 Canvas strip:** Live meters must be canvas meters with history and current value, in one DPR-aware canvas strip with approximately 150 CSS-pixel blocks in a fixed 32 CSS-pixel bottom bar; text equivalents must supplement, not replace, this visual surface.
- **DT-R19 Stable anatomy:** The bar must contain `[panel toggle + tabs] [canvas strip] [host segments]`. Opening a panel above it must not move the bar.
- **DT-R20 Separate interaction:** Clicking or focusing a meter must open its detail panel. Freeze must be a separate pointer/keyboard action; keyboard tooltips must be supported and no capability may depend on hover alone.
- **DT-R21 Styling boundary:** Meter APIs must be style-agnostic and accept semantic theme tokens compatible with a StyleX host, including light/dark palettes and visible keyboard focus.
- **DT-R22 Built-in coverage:** Reusable sources/adapters must cover FPS, long frames/jank with longtask fallback, heap/app memory, RPC in-flight/latency/errors, live child fibers, spans through the existing browser tracer/SpanRing seam, app counters/gauges, and React Profiler commits. WebSocket/sync status must be a host segment using host-supplied status, not a diagnostic transport.

### Must prove the boundary and measurements

- **DT-R23 Verification evidence:** Tests must prove zero disabled starts, production graph exclusion, scoped cleanup, single shared frame clock, independent readers, explicit availability, bounded retention, bracket eligibility, and accessible meter interactions. Assertions must use real measurements or injected deterministic capabilities, never fabricated production values.
- **DT-R24 Clean cutover:** Every migrated caller, example, and test must use the new contracts; obsolete engines, global bags, destructive readers, storage props, and decoration exports must be removed without deprecated aliases or compatibility shims.
