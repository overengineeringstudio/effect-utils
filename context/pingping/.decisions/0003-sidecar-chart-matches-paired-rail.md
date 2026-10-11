# Sidecar chart is as tall as a paired statistics rail

Status: accepted

## Context

The sidecar layout (decision 0002) showed a 7-row chart with six single
statistics beside its bottom 6 rows, so a host block took 8 lines. the user
asked on 2026-10-04 to pair the statistics and to make the chart only as tall
as the rail needs (design interview decision Q17, confirmed from a
preview). In the same session he asked to dim the minimap further, because it
competed with the chart for attention.

## Evidence and Argument

Pairs read naturally (Current next to Avg, Min next to Max, Received next to
Loss) and fit in about 33 columns, which the sidecar has from 111 columns. A
3-row chart keeps the shape of the history; taller charts did not add RTT
precision, because they stretch the same 8-level per-host scale.

## Options

| Option | Tradeoffs |
| --- | --- |
| 7-row chart, 6-row rail | Tall chart; 8 lines per host. |
| 5-row chart, 3-row rail at the bottom | 6 lines per host; two chart rows without statistics. |
| 3-row chart, 3-row rail | 4 lines per host; the chart is less tall. |

## Decision

From 111 columns, a host block is an identity line plus a 3-row chart with a
3-row rail beside it: Current/Avg, Min/Max, Received/Loss. When blocks do not
fit, the chart shrinks to 2 and 1 rows and the rail packs into the same rows.
The minimap uses only muted colors.

## Consequences

Twice as many hosts fit before charts shrink. Narrower layouts are unchanged.

## Amendment 1

The minimap colors failed pings muted red. Any column whose halves contain
a failed ping uses `MinimapLoss` inside the window (`Label` blended toward
`Bad`) or `MinimapLossFaint` outside it (`Faint` blended toward `Bad`).
Glyph shapes and the muted treatment of other cells are unchanged.

Zoomed-out cells aggregate many pings, and the reply glyph hid losses, so a
full outage looked like low RTT. the user chose option B (decision q33)
over a muted top-dot marker, a loss-fraction ramp and outage-vs-partial
colors, after comparing them live in the real `pingping`.

## Amendment 2

Amendment 1's palette and glyph rules remain in force, but its any-loss
color trigger is superseded by a majority rule. Sum completed samples and
losses across both Braille time halves: a glyph triggers muted red only when
it contains completed samples and `lost * 2 >= samples`, where `samples` is
replies plus losses. It then uses `MinimapLoss` inside the window or
`MinimapLossFaint` outside it. An empty glyph never triggers red; isolated
losses below the threshold keep
the ordinary muted foreground. Successful-stem priority, fixed loss-dot
shapes, tooltips and statistics are unchanged and retain all outcomes.

The trigger reflects sustained or majority loss rather than allowing one
failed ping in a dense zoomed-out bucket to color an otherwise healthy span.
