# Effect RPC Explorer React UI Requirements

## Context

`@overeng/effect-rpc-explorer-react` renders the typed, bounded inspection
projection defined by the [parent explorer](../requirements.md). It is a
read-only consumer of snapshots and deltas; it owns no Effect Protocol
decoration, content policy, or application RPC control.

## Assumptions

- **RPCX.UI-A01 Core contract:** This subsystem refines the core's typed
  inspector frames and record/descriptor model.
- **RPCX.UI-A02 Host mounting:** A host supplies an inspector client and decides
  where the React surface is mounted.
- **RPCX.UI-A03 Scoped styling:** StyleX token/theme scope is provided by the
  package and may be adapted by a host without changing semantic state.

## Acceptable Tradeoffs

- **RPCX.UI-T01 Expired selection:** A record evicted by core retention may
  disappear from the selected detail view with an explicit expiry notice.
- **RPCX.UI-T02 Bounded visual history:** The UI may virtualize or collapse
  records because the core model is already bounded.
- **RPCX.UI-T03 Content ambiguity:** Omitted, redacted, unsupported, and
  truncated values trade complete rendering for accurate safety signals.

## Requirements

### Must remain a pure typed client

- **RPCX.UI-R01 Package boundary:** The React package must depend only on public
  core schemas/client contracts and must not import Effect RPC wire types,
  Protocols, capture policy internals, or host transport code.
  Refines: RPCX-R03, RPCX-R26.
- **RPCX.UI-R02 Diagnostic-only behavior:** UI controls may inspect, filter,
  select, expand, copy safe identifiers, reconnect the inspector stream, or
  explicitly clear explorer-owned diagnostic history. They must not invoke,
  replay, retry, cancel, or otherwise alter application RPCs.
  Refines: RPCX-R02, RPCX-R24.
- **RPCX.UI-R03 Revision safety:** The client projection must apply only
  contiguous deltas, request/reset to a snapshot after revision mismatch, and
  never display a mixed-revision list/detail state.
  Refines: RPCX-R18, RPCX-R19, RPCX-R24.

### Must make live state understandable

- **RPCX.UI-R04 Lifecycle overview:** The primary surface must distinguish active,
  completed, failed, defect, interrupted, send-failed, notification, and
  uncertain states with text and non-color status cues.
  Refines: RPCX-R08, RPCX-R24.
- **RPCX.UI-R05 Dense record list:** The list must show descriptor identity,
  direction/side, lifecycle, relative time/duration, stream envelope/value
  counts, trace presence, and uncertainty/fault markers while supporting
  bounded-cost live updates.
  Refines: RPCX-R09, RPCX-R17, RPCX-R24.
- **RPCX.UI-R06 Inspectable detail:** Selected-record detail must expose an
  ordered timeline, safe captured content with policy source/mode, omitted and
  policy-fault states, descriptor schemas/projection warnings, trace fields,
  and retention/anomaly evidence.
  Refines: RPCX-R08, RPCX-R09, RPCX-R11, RPCX-R14, RPCX-R15, RPCX-R17, RPCX-R21,
  RPCX-R24.
- **RPCX.UI-R07 Honest fault presentation:** Connection-level faults must be
  presented as uncorrelated connection faults and each affected record as
  uncertain; the UI must not render a guessed causal application error.
  Refines: RPCX-R08, RPCX-R24.
- **RPCX.UI-R08 Value semantics:** The UI must visibly differentiate omitted,
  redacted, unsupported, and truncated values. It must never reconstruct or
  infer omitted content from descriptor names or a redaction label.
  Refines: RPCX-R14, RPCX-R15, RPCX-R24.

### Must be accessible, responsive, and styled locally

- **RPCX.UI-R09 React Aria semantics:** Collections, selection, tabs, disclosure,
  dialogs, tooltips, and buttons must use React Aria primitives or equivalent
  ARIA behavior with full keyboard operation.
  Refines: RPCX-R25, RPCX-R26.
- **RPCX.UI-R10 Focus stability:** Live insertions, completed-record movement,
  filtering, reset, and eviction must preserve focus on the same logical record
  where it remains present; otherwise move focus predictably to the list and
  announce the reason.
  Refines: RPCX-R17, RPCX-R25.
- **RPCX.UI-R11 Responsive dense layout:** Narrow layouts must preserve list and
  selected-detail access through an explicit drill-in/back interaction; wide
  layouts may show split panes. Information may collapse but must not become
  mouse-only or inaccessible.
  Refines: RPCX-R24, RPCX-R25.
- **RPCX.UI-R12 StyleX ownership:** Styling must use package-local StyleX tokens
  for typography, spacing, color, state, focus, and density; status meaning
  must survive host theme and high-contrast conditions.
  Refines: RPCX-R25, RPCX-R26.

### Must have executable visual evidence

- **RPCX.UI-R13 Deterministic stories:** Storybook must provide deterministic
  stories for empty/loading, active unary, completed stream, typed failure,
  defect, interrupted, send failure, uncertain connection fault, policy
  omit/reveal/redact/fault, truncation/eviction, and clear-history reset that
  preserves an active row, in narrow and wide layouts.
  Refines: RPCX-R27.
- **RPCX.UI-R14 Interactive/a11y stories:** Stories must exercise keyboard
  selection, filtering, disclosure, focus after live insertion and eviction,
  semantic status names, and no-color-only fault interpretation.
  Refines: RPCX-R25, RPCX-R27.
- **RPCX.UI-R15 Live protocol story:** One Storybook story must use an in-memory
  core inspector client to demonstrate snapshot followed by deltas, revision
  reset recovery after clear history, and absence of inspector self-observation.
  Refines: RPCX-R16, RPCX-R18, RPCX-R27.
- **RPCX.UI-R16 UI contract proof:** Tests must verify rendering from consumer
  observable core frames, not implementation wiring, and must cover each
  lifecycle/policy/retention boundary represented by the UI.
  Refines: RPCX-R28.

### Must preserve theme and schema meaning

- **RPCX.UI-R17 Dual color schemes:** The explorer must provide light and dark
  theme variants through semantic StyleX tokens and preserve accessible contrast,
  focus visibility, and state distinctions in both schemes across supported
  viewports.
  Refines: RPCX-R25, RPCX-R26.
- **RPCX.UI-R18 Schema-derived inspection:** Where a descriptor exposes
  projected Schema metadata, the UI must show channel fields as an accessible
  hierarchy using available titles, descriptions, examples, and required/optional
  semantics, and label captured normalized fields with their schema titles
  without reconstructing omitted or redacted values. Unavailable projections
  must be identified explicitly.
  Refines: RPCX-R09, RPCX-R14, RPCX-R15, RPCX-R24.
