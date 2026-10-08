# Devbar Requirements

## Context

The shell composes the stack described by the [vision](../vision.md), [parent requirements](../requirements.md), [parent spec](../spec.md), and [ontology](../ontology.md). It presents host-selected panels, a meter renderer slot, and host segments; it does not own instrumentation.

Decision references identify the confirmed choices captured by this VRS: Q1 canvas strip; Q3 independent renderers and shared clock; Q5 explicit composition; Q7 detail/freeze/keyboard interaction; Q12–Q13 independent packages and scoped enabling. The mission constraints govern controlled state, development defaults, theming, and zero disabled cost.

## Assumptions

- **DT.BAR-A01 Host lifetime:** The host owns its enabling boundary, application Scope, lazy imports, content inset, and persisted preferences.
- **DT.BAR-A02 Renderer ownership:** [Meters](../01-meters/spec.md) supplies the canvas strip, accessible text, tooltips, and source-backed detail content independently of this shell.

## Acceptable Tradeoffs

- **DT.BAR-T01 Narrow layout:** The strip may scroll horizontally rather than compressing approximately 150px meter blocks into unreadable histories.
- **DT.BAR-T02 Closed panels:** Closing a panel unmounts its content and projection subscriptions; explicitly enabled collection can continue without a panel.

## Requirements

### Must compose without owning tools

- **DT.BAR-R01 Anatomy:** The bottom row must be 32px high and ordered `[panel toggle + tabs] [canvas strip] [host segments]`; an open panel must appear above it without moving the row. Implements Q1 and mission anatomy.
- **DT.BAR-R02 Slots:** Hosts must explicitly supply all panels, the optional strip, and optional status/action segments. Empty slots must not install default tools or observations. Implements Q5.
- **DT.BAR-R03 Independence:** Devbar must not import meters, RPC observer, RPC integration, or explorer packages. Tool content must enter through public composition slots. Implements Q3 and Q12–Q13.
- **DT.BAR-R04 Shared measurement:** Devbar must remove its independent FPS observer and source-owning FPS component. Any FPS detail view must read the host's existing meter session. Implements Q3.

### Must expose one controlled interaction model

- **DT.BAR-R05 Controlled state:** `openPanel` and `onOpenPanelChange` must be the only panel-selection state contract. Internal local storage, `persist`, `storageKey`, and `deepLinkPanel` must be removed; hosts must migrate persistence and deep links. Implements mission controlled-state constraint.
- **DT.BAR-R06 Accessible controls:** Toggle, tabs, close action, Ctrl/Meta+Backquote, and unconsumed Escape must use the same controlled callback. Controls must expose names, focus indicators, expanded state, and their panel relationship.
- **DT.BAR-R07 Meter interaction:** A host-connected meter click or focus must open its associated detail panel. Keyboard users must access its tooltip and a separate freeze action; hover-only functionality and click-to-freeze substitution are excluded. Implements Q7.
- **DT.BAR-R08 Placement:** Viewport mode must dock to the viewport bottom; container mode must stay within a host-positioned container. The host, not the shell, must reserve the enabled row's content inset.
- **DT.BAR-R09 Themes:** Hosts must be able to override semantic colors and typography through theme tokens and StyleX-compatible styles without altering tool state or adopting a global stylesheet.

### Must be absent when disabled

- **DT.BAR-R10 Enabling boundary:** Development hosts must default diagnostics to enabled and production hosts to disabled. The host must own a compile-time guarded dynamic-import boundary; a disabled boundary must not import or mount diagnostic modules. Implements Q12–Q13 and mission constraints.
- **DT.BAR-R11 Zero runtime cost:** Disabled diagnostics must start no frame callbacks, timers, observers, listeners, source fibers, runtime metrics, Profiler, tracer hooks, or protocol hooks. Existing unrelated host telemetry must remain untouched.
- **DT.BAR-R12 Evidence:** Automated tests must prove disabled startup, enabled teardown/re-enabling, shared-clock behavior under multiple renderers and StrictMode, and production graph exclusion. A visually hidden enabled shell must not be mistaken for disabled instrumentation.
