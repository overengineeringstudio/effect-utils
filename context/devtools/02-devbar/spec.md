# Devbar Spec

This document specifies the developer shell. It builds on [requirements.md](./requirements.md) and the shared [ontology](../ontology.md).

## Status

Draft. The signatures define the intended clean cutover, not the currently exported implementation.

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
import type { StyleXStylesWithout } from '@stylexjs/stylex'

export interface DevbarPanel {
  readonly id: string
  readonly label: string
  readonly render: () => React.ReactNode
  readonly badge?: React.ReactNode
}
export interface DevbarSegment {
  readonly id: string
  readonly render: () => React.ReactNode
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

Panel and segment IDs are host-local, opaque, nonempty case-sensitive strings, unique within their respective lists. They are not protocol identifiers or storage keys. Unknown `openPanel` renders no panel; it does not manufacture a callback or mutate host state. The host reconciles removed IDs. No default panels, segments, strip, or meter list are injected.

The shell retains only ephemeral last-valid-panel bookkeeping for toggling, never selected-state or persistence ownership. The toggle proposes closing the selected panel, or opening the last valid panel, falling back to the first supplied panel. With no panels, toggle cannot propose an ID. Rejected host proposals leave the UI unchanged.

## Geometry and token contract

| Region         | Contract                                                                                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bottom row     | `height: 32px`; single nonwrapping line; no growth when panel opens; horizontal row scrolling rather than clipping when controls and strip minimum cannot fit                    |
| Viewport root  | fixed, bottom/left/right zero; existing default z-index 200                                                                                                                      |
| Container root | absolute, bottom/left/right zero relative to host positioned ancestor                                                                                                            |
| Panel          | above row; `height: min(48vh, 32rem)`; minimum height bounded by available container/viewport space rather than forcing overflow                                                 |
| Panel body     | flex column; `min-height: 0`, `min-width: 0`; selected content fills available space                                                                                             |
| Strip slot     | `flex: 1 1 auto`; configurable `stripMinWidth` in CSS pixels, default `160`; child container receives the full allocated flex width; horizontal scrolling when blocks do not fit |
| Host segments  | shrink before controls or the strip minimum; `min-width: 0`; horizontal scrolling within the group with a thin scrollbar; each segment does not shrink or wrap                   |

Traces: DT.BAR-R01, DT.BAR-R08–R09. Container panel height is additionally capped by the containing block's available height above the row. Host panel content owns internal table/detail scrolling. Opening a panel overlays host content rather than expanding the bottom inset. Only enabled placement reserves the row inset, under host control.

Width priority is panel toggle and panel buttons (never shrinking), then the strip's minimum, then host segments. The strip grows into remaining space. Segments yield width first and keep their status/actions reachable through their own horizontal scroll area. If the controls plus strip minimum do not fit, the entire row scrolls horizontally, remains 32px tall, and clips overflow to its scrollport: no slot may paint outside the row or overlap another slot.

Keep semantic `devbarTokens` roles `canvas`, `panel`, `panelActive`, `text`, `mutedText`, `border`, `focusRing`, `fontUi`, and `fontData`; light/dark theme objects and host-created themes set those roles. No hard-coded tool palette, global theme detection, or imported explorer theme belongs in the shell. Canvas colors are meter renderer tokens; host applies shell, meter, and explorer themes on a shared ancestor when desired. Geometry-owned position cannot be replaced through `style`.

## Interaction

```text
button / shortcut / meter activation
    -> host onOpenPanelChange(id | undefined)
    -> host openPanel prop
    -> selected panel render()
freeze -> meter renderer state only
```

Traces: DT.BAR-R05–R07.

Panel buttons expose `aria-expanded`; the open panel has a stable generated DOM ID and accessible label, and its corresponding controls expose `aria-controls`. Buttons remain native keyboard-operable controls, not incorrectly labelled ARIA tabs without implementing a tablist keyboard model. Ctrl or Meta plus unmodified Backquote toggles; respect `defaultPrevented`. Unconsumed Escape closes the panel. Keyboard listeners exist only while shell is mounted, and cleanup removes them. Closing after keyboard interaction restores focus to the initiating control if focus was inside removed panel content; pointer activation does not forcibly steal focus.

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

## Conformance and clean cutover

| Test fixture                    | Assertions                                                                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Disabled StrictMode mount       | loader calls zero; diagnostic rAF/cancel, timers, PerformanceObserver, listener, metric enablement, runtime acquisition, tracer/protocol hook counters all zero |
| Enabled then off/unmount        | every diagnostic lease returns to baseline; pending asynchronous callbacks publish nothing; unrelated host telemetry unchanged                                  |
| Two strips plus headless reader | one shared frame clock and source installation; renderer freeze/detach does not stop required sampling                                                          |
| Re-enable/StrictMode rehearsal  | no overlap from asynchronous cleanup; peak one installation per source and clock                                                                                |
| Production host fixture build   | emitted module/chunk graph contains no devbar, meters, integration, explorer, observer, or diagnostic-only import references                                    |
| Production browser fixture      | no diagnostic requests, listeners, observers, or scheduling                                                                                                     |
| Controlled interactions         | one callback path; rejected proposal leaves state unchanged; invalid ID renders closed; focus/Escape/tooltip/freeze parity                                      |

Traces: DT.BAR-R04–R07, DT.BAR-R11–R12. Tests measure diagnostic-owned work against a baseline; they must not assert absence of legitimate host scheduling. Remove `deepLinkPanel`, `storageKey`, `persist`, internal storage reads/writes, `FpsMeter`, `FpsMeterProps`, and the standalone `observeFps` implementation/exports/tests when implementation adopts this contract. Migrate every consumer and example to host state and shared meter readings; no deprecated aliases or parallel FPS loop remain.
