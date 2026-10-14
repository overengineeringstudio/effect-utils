# Devbar Spec

This document specifies the developer shell. It builds on [requirements.md](./requirements.md) and the shared [ontology](../ontology.md).

## Status

Active.

## Scope

Defines shell slots, panel state, geometry, theming, and host enabling conformance. Does not define source acquisition, canvas drawing, capture policy, or RPC transport; see [meters](../01-meters/spec.md), [observer](../03-rpc-observer/spec.md), and [integration](../04-rpc-devtools/spec.md).

## Composition API

```text
Devbar
├─ panel slot (only selected panel mounted)
└─ fixed-height bottom row
   ├─ toggle + panel buttons
   ├─ strip slot (host-owned single DPR canvas)
   └─ host segments (status/actions)
```

Traces: DT.BAR-R01–R05, DT.BAR-R08–R09.

```ts
import type * as React from 'react'
import type { StyleXStyles, StyleXStylesWithout } from '@stylexjs/stylex'

export interface DevbarPanel {
  readonly id: string
  readonly label: string
  readonly render: () => React.ReactNode
  readonly badge?: React.ReactNode
}
export interface DevbarSegment {
  readonly id: string
  /** Higher values remain visible longer; default 0. */
  readonly priority?: number
  readonly render: () => React.ReactNode
  readonly hasAlert?: boolean
}
export interface DevbarProps {
  readonly panels: readonly DevbarPanel[]
  readonly strip?: React.ReactNode
  readonly stripMinWidth?: number
  readonly segments?: readonly DevbarSegment[]
  readonly openPanel: string | undefined
  readonly onOpenPanelChange: (id: string | undefined) => void
  readonly placement?: 'viewport' | 'container'
  readonly style?: StyleXStylesWithout<{ position: 'fixed' }>
}
export declare const Devbar: (props: DevbarProps) => React.ReactNode
```

The root entry also exports the nonmodal `AnchoredDisclosure`:

```ts
interface AnchoredDisclosureProps {
  readonly label: string
  readonly trigger: React.ReactNode
  readonly triggerLabel: string
  readonly hasUnseen?: boolean
  readonly children: React.ReactNode
  readonly onOpenChange?: (open: boolean) => void
  readonly style?: StyleXStyles
  readonly triggerRef?: React.RefObject<HTMLButtonElement | null>
  readonly triggerProps?: Pick<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    'onFocus' | 'onBlur' | 'aria-describedby'
  >
}
declare const AnchoredDisclosure: (props: AnchoredDisclosureProps) => React.ReactNode
```

Traces: DT.BAR-R13. The native button owns uncontrolled ephemeral expanded state,
`aria-haspopup="dialog"`, `aria-expanded`, and `aria-controls`. The host supplies
the complete accessible trigger name, including any unseen suffix. The optional
dot uses `focusRing` and is hidden from assistive technology. Content mounts only
while open; hosts own content, fetching, failures, retry, and unseen policy. The
kit introduces no changelog data model or loading state. `onOpenChange` notifies
once per transition, never on rerender. Changing unseen state does not remount
the open content. Panel selection is independent.

The shared native `popover="auto"` surface inherits its ancestor's theme without
a body portal or dependency. Opening focuses the named dialog above the trigger,
or below only when the space above is smaller than the space below. The chosen
side bounds height to `min(24rem, <available space minus 8px>)`; excess content
scrolls without crossing the viewport edge, including triggers inside overflow.
Its measured width clamps its left edge to at least 8px and right edge to at most
viewport width minus 8px. Width is bounded by `calc(100vw - 1rem)`. Size and viewport changes
reposition the open surface. Native pointer light dismissal updates expanded
state; Escape consumes the event and restores trigger focus. Closing unmounts
content. Open-state teardown notifies the host; there is no cross-mount state.

Panel and segment IDs are host-local, opaque, nonempty case-sensitive strings, unique within their respective lists. They are not protocol identifiers or storage keys. Unknown `openPanel` renders no panel; it does not manufacture a callback or mutate host state. The host reconciles removed IDs. No default panels, segments, strip, or meter list are injected.

The shell retains only ephemeral last-valid-panel bookkeeping for toggling, never selected-state or persistence ownership. The toggle proposes closing the selected panel, or opening the last valid panel, falling back to the first supplied panel. With no panels, toggle cannot propose an ID. Rejected host proposals leave the UI unchanged.

## Geometry and token contract

| Region         | Contract                                                                                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bottom row     | `height: 32px`; single nonwrapping line; no growth when panel opens; horizontal row scrolling rather than clipping when controls and strip minimum cannot fit                       |
| Viewport root  | fixed, bottom/left/right zero; existing default z-index 200                                                                                                                         |
| Container root | absolute, bottom/left/right zero relative to host positioned ancestor                                                                                                               |
| Panel          | above row; `height: min(48vh, 32rem)`; minimum height bounded by available container/viewport space rather than forcing overflow                                                    |
| Panel body     | flex column; `min-height: 0`, `min-width: 0`; selected content fills available space                                                                                                |
| Strip slot     | `flex: 1 1 auto`; configurable `stripMinWidth` in CSS pixels, default `160`; child container receives the full allocated flex width; horizontal scrolling when blocks do not fit    |
| Host segments  | shrink before controls or the strip minimum; whole-segment priority hiding; no internal row scrolling, shrinking, wrapping, or mid-word clipping; `+N` keeps hidden items reachable |

Traces: DT.BAR-R01, DT.BAR-R08–R09. Container panel height is additionally capped by the containing block's available height above the row. Host panel content owns internal table/detail scrolling. Opening a panel overlays host content rather than expanding the bottom inset. Only enabled placement reserves the row inset, under host control.

Width priority is panel toggle and panel buttons (never shrinking), then the strip's minimum, then host segments. The strip grows into remaining space. Segments yield width first by hiding complete items. If the controls, strip minimum, and overflow control do not fit, the entire row scrolls horizontally, remains 32px tall, and confines its contents to its scrollport: no slot may overlap another slot.

Keep semantic `devbarTokens` roles `canvas`, `panel`, `panelActive`, `text`, `mutedText`, `border`, `focusRing`, `fontUi`, and `fontData`; light/dark theme objects and host-created themes set those roles. No hard-coded tool palette, global theme detection, or imported explorer theme belongs in the shell. Canvas colors are meter renderer tokens; host applies shell, meter, and explorer themes on a shared ancestor when desired. Geometry-owned position cannot be replaced through `style`.

### Segment fitting and overflow

```text
row + controls + natural segment widths --ResizeObserver--> width budget
  -> hide lowest priority (later declaration first for ties)
  -> visible segments in declaration order + "+N"
  -> keyboard/pointer disclosure -> full hidden segment content
```

Traces: DT.BAR-R01, DT.BAR-R08–R09. `DevbarSegment.priority` defaults to `0`; larger values remain visible longer. Hiding removes the lowest priority first, breaking ties by hiding the later-declared item. The visible items retain declaration order. Once anything is hidden, fitting reserves the overflow control and its inter-item gap. Keep the highest-priority segment if it fits alongside overflow; otherwise show only overflow. When the width grows, items reappear according to the same calculation, without a separate restore order.

The pure `fitSegments({ segments: [{ id, width, priority? }], available, overflowWidth, gap? })` helper returns visible IDs. It is exported from its source module for unit testing, not from the package root. Widths exclude gaps; an all-fit result does not reserve overflow. Unit coverage includes priorities, default priority, ties, declaration order, gap/control accounting, exact boundaries, all-fit, empty, and none-fit cases.

Each segment has a natural-width inner node. Hidden segments stay mounted inside zero-sized, invisible, clipped wrappers outside layout flow; those wrappers are inert and absent from the accessibility tree. Measuring the inner nodes preserves their intrinsic widths even while hidden and tracks content or font changes without mounting a second measurement copy. A similarly hidden sample measures `+<segment-count>` with tabular numerals, reserving enough overflow width for every possible hidden count.

One `ResizeObserver` observes the segment group, row, controls, natural-width nodes, and overflow sample. The budget is computed from the row's inner width minus its padding, gaps, nonshrinking controls, and `stripMinWidth`, never from the current visible set. The group's flex basis remains the sum of all natural widths and gaps even while items are hidden. This makes hiding independent of the widths it changes. Initial layout measurement occurs before paint; source snapshots publish only when measurements change. Natural/control widths round up and the available budget rounds down to CSS pixels to avoid boundary oscillation. There is no polling, animation-frame loop, or internal status scrollbar.

The native `+N` button's accessible name is `N more status items: <hidden ids in declaration order>`; its expanded state and controls relationship identify the named `More status items` dialog. Opening focuses the nonmodal native auto-popover, which uses the shared above/below collision placement in the browser's top layer and retains inherited host theme tokens. It renders hidden segments in declaration order at full natural width; unusually wide or tall content can scroll within the disclosure rather than being truncated. Pointer light dismissal is browser-owned. While overflow is open, element-level `onKeyDown` handlers on its trigger and dialog consume unhandled Escape, close overflow before the shell panel's handler, and return focus to the trigger. Once Tab moves focus outside those elements and their React descendants, Escape no longer closes overflow through these handlers; an unconsumed event inside the bar may reach the shell panel, while events outside the bar remain untouched. Fitting away the final hidden item closes the disclosure.

Hidden `hasAlert` values aggregate onto the overflow dot and append
`, including unseen changes` to its accessible name. Hosts explicitly mirror
their build disclosure's `hasUnseen` into the segment's `hasAlert`; the shell
does not inspect opaque renderers. The overflow measuring sample reserves dot
width when any segment has an alert. A hidden build's overflow copy remains
keyboard-operable and can open its anchored disclosure. Fitting away overflow
closes it without stealing focus and unmounts its interactive content.

Escape follows React bubbling ancestry from the innermost focused layer: a host
popover, disclosure or identity tooltip, enclosing overflow, then panel. Each
layer uses an element-level `onKeyDown` on its content or trigger, respects
`defaultPrevented`, and consumes its own Escape once. Host-owned portals retain
React ancestry so nested handlers run first; unrelated host inputs do not reach
these handlers. Disclosure and overflow close restore their respective trigger
focus. A hovered tooltip does not intercept Escape from elsewhere in the bar
or host app.

The `Narrow600` story supplies version (`1`), websocket (`4`), HTTP (`3`), subscriptions (`2`), and message-rate (`0`) priorities with deterministic realistic text. Its play assertions check the 600px host geometry, intact visible segments wholly within the row, priority ordering, the hidden-ID accessible name, complete overflow contents, and Escape/focus restoration.

## Optional build identity segment

```text
host canonical build identity
  -> @overeng/devbar/build-identity -> @overeng/utils/build-identity
  -> host-supplied segment.render()
  -> short text; hover or focus reveals version/deployment detail lines
```

Traces: DT.BAR-R01, DT.BAR-R04–R07, DT.BAR-R09. The shell does not install a
build segment by default. The optional `@overeng/devbar/build-identity` entry
exports `BuildIdentitySegment`; the root entry does not re-export it or reach
`@overeng/utils`. Hosts pass their canonical identity without formatting:

```ts
import type * as React from 'react'
import type { BuildIdentity } from '@overeng/utils/build-identity'
import type { StyleXStyles } from '@stylexjs/stylex'

interface BuildIdentitySegmentProps {
  readonly identity: BuildIdentity
  readonly now?: number // fixed Unix seconds; omit for the mounted clock
  readonly style?: StyleXStyles
  readonly disclosure?: {
    readonly label: string
    readonly hasUnseen?: boolean
    readonly render: () => React.ReactNode
    readonly onOpenChange?: (open: boolean) => void
  }
}
declare const BuildIdentitySegment: (props: BuildIdentitySegmentProps) => React.ReactNode
```

```tsx
import { BuildIdentitySegment } from '@overeng/devbar/build-identity'

const segments = [
  {
    id: 'build',
    render: () => <BuildIdentitySegment identity={buildIdentity} />,
  },
]
```

The formatter contract and bucket semantics belong to
[build identity](../../builds/01-identity/spec.md#human-short-and-details-forms).
The segment consumes semantic `devbarTokens` for scheme-varying values and data
typography, inheriting host themes. Its native focusable button exposes the short
form and associates the visible detail tooltip with `aria-describedby`. Hover
and keyboard focus reveal identical details; users can move onto the details,
and Escape dismisses them without closing a shell panel or removing focus.
The tooltip is positioned above the triggering control outside the row's
horizontal scrollport. Composed disclosures share the actual native button ref,
so the first hover anchors correctly without prior focus. Geometry is read in
a layout effect when the tooltip becomes visible, not in pointer handlers.

With `disclosure`, the build button names itself
`Build identity: <short>, show <label>` and appends `, unseen changes` while
`hasUnseen` is true. Enter and Space open the shared anchored dialog. Its
aria-hidden dot updates live. `render()` runs only while open; opening can
notify the host to mark entries seen without remounting the dialog. The identity
tooltip remains available on hover and focus, but is suppressed while the dialog
is open. Opening and closing dismiss the current tooltip; subsequent hover or
focus can reveal it again. The tooltip's element-level Escape handler acts only
while visible, consumes Escape before enclosing layers, and preserves focus.

Live segments share one sixty-second clock while at least one segment is mounted.
Unmounting the final subscriber clears the interval; import alone schedules
nothing. A supplied `now` is deterministic and subscribes to no clock. Storybook
shows clean, dirty, and missing-commit-time identities in light and dark themes,
with hover, focus, dismissal, and detail assertions.

### Dependency footprint tradeoff

The formatter module itself has zero runtime imports. However, `@overeng/utils`
has package-level runtime dependencies on Effect/platform-node/opentelemetry,
Effect distributed-lock, OTEL contract/API, noble hashes, StyleX build tooling,
unplugin, and PostCSS. Its install-mode composition also promotes Vitest and
Effect-Vitest into runtime dependencies. Nonoptional peers include
Effect/platform-node/opentelemetry and Playwright. A direct
runtime dependency would bring that installation footprint into shell-only
hosts even though the formatter's browser module graph is small.

Devbar therefore declares utils as an **optional peer** and a development
dependency, not a runtime dependency. The optional segment is a separate
publication entry, and its utils import remains external. Shell-only hosts do
not need utils; hosts choosing the segment provide utils and accept its
package-level install footprint. A boundary test traverses the root entry
graph to prevent accidental root re-exports or utils imports.

Alternative ownership models are a separate tiny formatter package, or moving
utils' Node/tooling dependencies behind optional peers or separate packages.
Those require broader package-contract changes; the optional entry/peer keeps
the shell light without duplicating the formatter or silently adding that graph.

## Interaction

```text
button / shortcut / meter activation
    -> host onOpenPanelChange(id | undefined)
    -> host openPanel prop
    -> selected panel render()
freeze -> meter renderer state only
```

Traces: DT.BAR-R05–R07.

Panel buttons expose `aria-expanded`; the open panel has a stable generated DOM ID and accessible label, and its corresponding controls expose `aria-controls`. Buttons remain native keyboard-operable controls, not incorrectly labelled ARIA tabs without implementing a tablist keyboard model. Ctrl or Meta plus unmodified Backquote toggles globally while mounted, respects `defaultPrevented`, and removes its window listener on unmount. Escape is handled by the shell root's bubbling `onKeyDown` only when it is unconsumed and the root physically contains the event target; outside focus and portalled content cannot close the panel. Escape from the row or panel closes it and returns focus to the toggle. Any close, including pointer actions and host-controlled closes, returns focus to the toggle if focus was inside the removed panel; closes with focus outside the panel do not steal focus.

Focus restoration is determined immediately before the actual panel removal,
not retained from a rejected close proposal. Each new proposal clears pending
restoration intent. For Escape from the row, the focused element at the proposal
must still be focused inside the bar when the panel is removed; moving focus to
the host app before a later controlled close prevents focus theft.

The meter renderer owns DOM focus targets, text equivalents, and tooltips. `MeterStrip.onOpenDetail({ id })` delegates click and Enter/Space activation to the host; focus alone shows a tooltip without opening a panel. Tooltip access remains possible without hover. Freeze is a distinct named button/action and affects rendering, not source collection or headless readers. A repeated activation of the already-open meter keeps its panel open.

The host-composition story supplies two panels, `rpc` and `meters`, yielding three bottom-row controls: Dev tools, RPC, and Meters. Non-RPC strip activation sets the host-selected meter and opens `meters`; `rpc.*` activation opens `rpc`. The Meters panel uses [`MetersPanel`](../01-meters/spec.md#react-bindings) to list every supplied block and render the existing detail view for the selection, including RPC meter readings. It does not register one shell panel per meter. Panel-local selection, persistence, and unknown-meter fallback belong to the host; see [host integration](../04-rpc-devtools/spec.md#host-integration). This composition is an example, not shell defaults.

## Host enabling boundary

```text
compile-time DEV false -> no reachable diagnostic imports
DEV true + preference false -> no loader call
DEV true + preference true -> load host diagnostics -> acquire Scope -> mount
turn off -> unmount + release diagnostics + rebuild undecorated transport
```

Traces: DT.BAR-R10–R12. The following is a host pattern, not a new devbar boundary export:

```ts
const loadDiagnostics = import.meta.env.DEV ? () => import('./host-diagnostics.tsx') : undefined

export const startHostDiagnostics = async (options: {
  readonly enabled: boolean
}): Promise<(() => Promise<void>) | undefined> => {
  if (loadDiagnostics === undefined || options.enabled === false) return undefined
  const { mountDiagnostics } = await loadDiagnostics()
  return mountDiagnostics()
}
```

`mountDiagnostics` is host-owned and acquires/relinquishes the diagnostics scope and UI together; its exact transport composition is specified in [integration](../04-rpc-devtools/spec.md#host-integration). The development preference defaults to true, is read under the DEV guard, and its storage policy belongs to the host. A changed preference rebuilds the host transport scope, not just shell visibility. No source/session construction, Profiler mounting, app event subscription, or runtime acquisition may occur above the guarded loader. Do not implement an always-running noop service. A production diagnostic build is an explicit separate host configuration, not the default.

## Conformance

| Test fixture                    | Assertions                                                                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Disabled StrictMode mount       | loader calls zero; diagnostic rAF/cancel, timers, PerformanceObserver, listener, metric enablement, runtime acquisition, tracer/protocol hook counters all zero |
| Enabled then off/unmount        | every diagnostic lease returns to baseline; pending asynchronous callbacks publish nothing; unrelated host telemetry unchanged                                  |
| Two strips plus headless reader | one shared frame clock and source installation; renderer freeze/detach does not stop required sampling                                                          |
| Re-enable/StrictMode rehearsal  | no overlap from asynchronous cleanup; peak one installation per source and clock                                                                                |
| Production host fixture build   | emitted module/chunk graph contains no devbar, meters, integration, explorer, observer, or diagnostic-only import references                                    |
| Production browser fixture      | no diagnostic requests, listeners, observers, or scheduling                                                                                                     |
| Controlled interactions         | one callback path; rejected proposal leaves state unchanged; invalid ID renders closed; focus/Escape/tooltip/freeze parity                                      |

Traces: DT.BAR-R04–R07, DT.BAR-R11–R13. Tests measure diagnostic-owned work against a baseline; they must not assert absence of legitimate host scheduling. Selection, persistence, and deep links are host-owned; the shell has no independent FPS observer or source-owning component. FPS detail uses the host's existing meter readings. Disclosure coverage includes lazy mounting, one notification per transition, live unseen changes, keyboard activation, nested Escape ordering, focus restoration, alert aggregation, both horizontal collision boundaries, short-viewport above/below bounds for overflow-list triggers, first-hover tooltip anchoring, host retry, and light/dark wide/crowded layouts.

Native light-dismissal assertions use the Storybook gate's Playwright-backed
`vitest/browser` pointer input for plain, overflow-nested, and panel-open
disclosures. Synthetic Storybook events retain portable Space/Escape coverage;
they do not stand in for browser-owned pointer dismissal.
