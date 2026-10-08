# Meters Requirements

## Context

Meters supplies the measurement foundation for the devtools stack. This contract
refines [system requirements](../requirements.md), especially DT-R01–R04,
DT-R09–R11, DT-R13–R18, DT-R21–R24. Implementation is specified in
[spec.md](./spec.md); terminology is inherited from [ontology.md](../ontology.md).
The [devbar](../02-devbar/requirements.md) composes these surfaces, and
[RPC integration](../04-rpc-devtools/requirements.md) supplies RPC sources without
introducing an RPC dependency into meters.

## Assumptions

- **DT.MET-A01 Scoped Effect host:** The host supplies the Effect runtime and scope needed by selected sources; React bindings use the host's Effect/React runtime integration.
- **DT.MET-A02 Platform evidence:** Browser APIs are feature-detected at source acquisition. An injected monotonic clock and visibility interface are available for deterministic tests.
- **DT.MET-A03 Explicit metric configuration:** Reading an Effect runtime gauge does not establish that the observed application enabled runtime metrics; the host supplies that configuration evidence and metric context.

## Acceptable Tradeoffs

- **DT.MET-T01 Frame estimates:** Skipped-frame estimates derive from rAF scheduling normalized to calibrated buckets, not direct compositor presentation evidence. Unsupported refresh estimates remain explicitly uncalibrated.
- **DT.MET-T02 Shared runtime scope:** The active-child-fibers gauge can include child fibers from other roots sharing the configured metric context. The label and details expose that scope rather than claiming an isolated application count.
- **DT.MET-T03 Subtree commits:** A React Profiler observes commits in its subtree, not function invocations or scheduler priority. The host selects profiler granularity.
- **DT.MET-T04 Frozen retention:** A frozen renderer captures a bounded view. It need not retain unbounded history while collection continues.
- **DT.MET-T05 UI publication:** Text and React snapshots may update less often than source acquisition; their age is visible and canvas/headless reads remain current.

## Requirements

### Must separate acquisition from presentation

- **DT.MET-R01 Scoped sources:** A source must be a scoped Effect resource with acquire/release semantics and an explicit per-frame, interval, or event cadence. Configuration/factory calls must be inert.
- **DT.MET-R02 One session clock:** All per-frame sources and renderers in a session must share at most one visibility-aware frame loop. Adding readers, blocks, or strips must not add loops.
- **DT.MET-R03 Independent renderers:** Canvas, headless, accessible-text, tooltip, and detail renderers must read the same store without starting or stopping sources. Detach and freeze must not interrupt measurement.
- **DT.MET-R04 Explicit configuration:** A session must start only the host-selected sources and display only the host-selected blocks. Core imports must not import React, canvas, RPC, StyleX, or browser telemetry adapters.

### Must provide bounded, non-destructive evidence

- **DT.MET-R05 Typed series:** Series identities and payloads must be typed. Values, unavailable observations, and gaps must be separate tagged variants; zero and sentinel numbers must never mean unavailable.
- **DT.MET-R06 Shared rings:** Each source must declare its own finite series capacity. Appends must be constant-time without shifting/copying the whole history; readers must not drain or reset shared state.
- **DT.MET-R07 Retention evidence:** Views/snapshots must expose capacity, retained time range, and cumulative overflow. The approximately 10s visual history window must not silently imply 10s of retained evidence when capacity is insufficient.
- **DT.MET-R08 Stable snapshots:** Immutable external-store snapshots must keep identity until the observed revision changes. Full arrays must be materialized only on explicit snapshot reads, not every frame.
- **DT.MET-R09 Cumulative instrumentation:** Typed session instrumentation must distinguish monotonic `counter.add` from `gauge.set`. Brackets and visual rates must read the same totals non-destructively; no `globalThis.__debug`, declaration-merging bag, or destructive reset helpers may remain.

### Must preserve frame bookkeeping honestly

- **DT.MET-R10 Captured versus skipped:** Frame collection must preserve lifetime captured-frame and skipped-frame totals separately from trailing statistics and ring retention. Calibration changes/remounts must not reset totals or introduce artificial misses.
- **DT.MET-R11 Bucket calibration:** Frame calibration must support 60/120/144/160/240 FPS buckets and distinguish pending, calibrated, and unsupported calibration. Skipped-frame gates must be ineligible without valid calibration.
- **DT.MET-R12 Trailing statistics:** Frame snapshots must provide observed average FPS and duration p50/p99 over a 2s trailing window, distinguish missing evidence, and never substitute those values for bracket-scoped results.
- **DT.MET-R13 Visibility gaps:** Hidden pages must stop frame work and periodic browser polling, record a visibility gap on resume, and rebase timing without counting the hidden interval as a burst of skipped frames. Frame-settle operations must terminate when hidden or stopped.

### Must have correct scoped lifetimes

- **DT.MET-R14 Lease safety:** Shared session acquisition must install each selected collector once; last release must cancel browser work and serialize later reacquisition behind unfinished cleanup. StrictMode rehearsal must preserve cumulative session state without overlapping resources.
- **DT.MET-R15 Late-result safety:** Pending interval/probe work must be single-flight, cancellable at scope release, and prevented from publishing late results after release.
- **DT.MET-R16 Explicit failures:** Unsupported capability and expected runtime sampling failure must produce unavailable evidence with a reason. Acquisition/configuration failures and unexpected defects must remain observable, not be silently replaced by numbers.

### Must support truthful performance brackets

- **DT.MET-R17 Split brackets:** Headless APIs must expose `beginMeasure`, `endMeasure`, and `measureWindow`, with serializable handles suitable for a host-selected automation bridge and explicit settlement options.
- **DT.MET-R18 Bracket deltas:** Results must contain bracket duration, captured/skipped-frame deltas, bracket-scoped average FPS, and monotonic instrument counter deltas. Gauges must not be treated as counters; history eviction must not erase cumulative deltas.
- **DT.MET-R19 Completeness:** `endMeasure` must return `Complete | Incomplete`; hidden time, invalid calibration, stopped collection, missing source evidence, or correlation loss must make affected gates ineligible with explicit reasons, never an apparently healthy zero.
- **DT.MET-R20 Handle integrity:** A handle must be validated against its session, generation, and live registry; duplicate end, forged/modified handle, and cross-session use must fail explicitly. Failed/interrupted work must close its bracket without masking the work failure.
- **DT.MET-R21 No implicit bridge:** No browser global or automation bridge may be installed by default. An opt-in bridge must register/unregister directly within a scope without polling or serving as the instrumentation transport.

### Must cover actual built-in signals

- **DT.MET-R22 Jank capability:** Long-frame observation must use LoAF when supported, otherwise longtask with distinct labelling; absent support must produce `n/a`. The fallback must not invent LoAF-only fields or double-count overlapping feeds.
- **DT.MET-R23 Distinct memory:** A strip heap source must read `performance.memory` and show `n/a` where absent. The detail-only application-memory probe must be opt-in, require cross-origin isolation, remain single-flight, and never change COOP/COEP or substitute heap bytes.
- **DT.MET-R24 Runtime fibers:** The fiber source must read `child_fibers_active` in the host-supplied enabled metric context, label it **active child fibers**, and show `n/a` until enablement is known. It must not enable metrics or replace the runtime service itself.
- **DT.MET-R25 Existing tracer seam:** Span sources must reuse the otel-browser SpanRing/tracer seam, keep lifetime completion counters independent of retained-ring length, and not install an exporter or duplicate tracer wrapper.
- **DT.MET-R26 Typed app instruments:** Hosts must be able to declare typed counters/gauges and supply cadence-specific readers or event writers without global instrumentation or a custom renderer for ordinary threshold values.
- **DT.MET-R27 Real React commits:** React instrumentation must use actual Profiler commit callbacks, record per-id monotonic commit counts and durations, and expose absent callback capability/configuration as `n/a`. It must not infer render priority or function-call counts.
- **DT.MET-R28 External integrations:** RPC source payloads must enter through generic source/series contracts from rpc-devtools, not a meters RPC module. Host WebSocket/sync state must use existing connections and may be supplied as a host segment or generic status series; meters must not create a transport.

### Must render accessible, themed evidence

- **DT.MET-R29 DPR canvas:** A strip must use one canvas at actual fractional DPR, with time-based history and history/value blocks. The devbar composition uses 32 CSS-pixel height and approximately 150 CSS-pixel blocks.
- **DT.MET-R30 Equivalent outputs:** Each block must have labelled text output and a keyboard-accessible DOM tooltip exposing unit, sample age, retained range, and unavailable reason. Canvas output must not be the sole accessible evidence.
- **DT.MET-R31 Separate actions:** The meter hit/focus target must expose a detail-activation callback independently from freeze. Freeze must be keyboard/pointer accessible and affect only the renderer snapshot; no hover-only pause behavior may remain.
- **DT.MET-R32 Semantic themes:** Renderers must accept semantic theme tokens, support light/dark contrast and visible focus, and avoid style-system dependencies and per-frame computed-style reads.

### Must support a clean migration and conformance

- **DT.MET-R33 Clean surface:** Existing engine/block/global APIs must be replaced at all migrated callsites without aliases. Source sampling must no longer be bundled into block factories or owned by each grid.
- **DT.MET-R34 Deterministic evidence:** Tests must drive injected clock/visibility/observer/probe capabilities and prove independent readers, source-specific overflow, calibration transitions, lifecycle cleanup, bracket integrity/completeness, DPR rendering, and accessible action parity, in addition to the system's disabled-boundary tests.
