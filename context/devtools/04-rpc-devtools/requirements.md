# RPC Devtools Integration Requirements

## Context

`@overeng/rpc-devtools` composes [meters](../01-meters/spec.md), [shared observation](../03-rpc-observer/spec.md), [devbar](../02-devbar/spec.md), and [standalone explorer](../../effect-rpc-explorer/spec.md) under the [parent requirements](../requirements.md) and [ontology](../ontology.md).

This subsystem implements Q9 shared observer fan-out, Q12–Q13 separate `/core` and `/react` integration and transport-scope rebuilding, Q5 explicit meter selection, Q7 meter detail interaction, and Q10 bounded source history. Q4 identifies the first canary host followed by existing hosts; adoption remains host-owned, not integration-owned.

## Assumptions

- **DT.RPC-A01 Host transport:** The host already owns an application RPC group, raw protocol, transport/runtime scope, explorer capture configuration, and development enabling decision.
- **DT.RPC-A02 Independent primitives:** Core explorer remains usable without this package; meters remains RPC-independent and devbar remains content-independent.

## Acceptable Tradeoffs

- **DT.RPC-T01 Explicit enable costs:** Enabled collection continues with a closed panel; hiding UI is not observation disablement.
- **DT.RPC-T02 Bounded latency window:** A percentile may describe fewer completions than the requested time window when completion capacity is exhausted, provided truncation is explicit.

## Requirements

### Must compose independent primitives

- **DT.RPC-R01 Package shape:** `/core` must work without React/DOM/UI dependencies. `/react` must provide `rpcExplorerPanel({client,id,label})`, lazily loading explorer-react into a devbar panel slot. No eager root UI barrel may defeat lazy loading. Implements Q12–Q13.
- **DT.RPC-R02 Core constructor:** `makeRpcDevtools({group,config,side,meters})` must return a scoped composition exposing client/server protocol decoration, RPC meter source, and explorer client. All meter selection and bounds must be explicit. Implements Q5 and Q12–Q13.
- **DT.RPC-R03 Single observation:** Explorer capture and RPC metadata meters must share one decorated transport and observer. RPC metrics must not read captured payloads or normalization duration. Implements Q9.
- **DT.RPC-R04 Dependency direction:** Devbar and explorer must not import each other or integration; meters must not import RPC. Standalone explorer must remain supported. Implements Q12–Q13.
- **DT.RPC-R05 Ownership:** Host transport lifetime must govern observer, explorer, client bridge, and source lifetime; panel lifetime must govern only projection subscriptions. Enabling/disabling observation must rebuild the host transport scope. Implements Q12–Q13.

### Must measure actual RPC lifecycle

- **DT.RPC-R06 Meter meanings:** Provide explicitly selected in-flight, request rate, error rate, and request-latency percentile series using canonical lifecycle events and monotonic timestamps. Cancellation must remain distinct from errors; successful notifications must not masquerade as response latency.
- **DT.RPC-R07 Bounded history:** RPC completion windows and series capacities must be bounded per source, with visible overflow/truncation and non-destructive reads. Empty latency windows must yield explicit unavailable evidence, not invented zero latency. Implements Q10.
- **DT.RPC-R08 Bridge correctness:** The local explorer client must use inspector snapshot/watch/clear semantics, preserve revision/reset/overflow behavior, and cancel watches on iterator return or scope close. Inspector traffic must not observe itself.

### Must fit the host boundary and shell

- **DT.RPC-R09 Panel sizing:** The adapter must fill the shell panel's available height/width without retaining standalone explorer's fixed-height default; internal explorer scrollers must remain usable. Standalone dimensions must remain unchanged.
- **DT.RPC-R10 Host policy:** Integration must not mount a dock, choose default meters, persist state, enable runtime metrics, infer theme, or modify production defaults. The host must own enablement, lazy imports, panels, meter activation, and persistence. Implements Q5, Q7, Q12–Q13.
- **DT.RPC-R11 Disabled evidence:** Host fixtures must prove compile-time production exclusion and zero diagnostic import/acquisition/hooks/work when disabled, plus scoped teardown and rebuild on preference change.
- **DT.RPC-R12 Adoption boundary:** The first canary host and later existing hosts must each own their adoption and transport-boundary integration; public examples must remain host-neutral. Implements Q4.
