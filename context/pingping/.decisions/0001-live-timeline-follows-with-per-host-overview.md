# Live timeline follows newest; a per-host overview navigates history

Status: accepted

## Context

The RTT timeline is zoomable and pannable (R14). As probes accumulate, the
live view must either keep its resolution and pan, or keep the whole run in
view and coarsen. the user also asked for a minimap while zoomed or panning,
and for a hover marker that does not hide the hovered bar. Decided with
the user in an interview on 2026-10-02 (design interview decisions
q5-q8).

## Evidence and Argument

The follow behavior was already built and tested end to end in a real PTY
(zoom keeps the view live, drag pauses, `0` returns live; PR #4360 commit
cd456c6). Hosts differ in RTT scale (about 13 ms vs 4 ms in the same run), so a
shared chart would blend unrelated shapes; a per-host overview reuses the
existing bucketing on each host's own scale. Hover hit-testing already maps
pointer rows and columns to `(host, cell)`, so overview navigation needs no
new terminal capability. Reverse video on the hovered cell turned the bar into
a full block, hiding its height.

## Options

| Option                                   | Tradeoffs                                                                                     |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| Follow newest at a fixed zoom            | Stable, readable resolution like `ping`; whole-run view needs manual zoom-out or an overview. |
| Fit the whole run, coarsen over time     | Whole session always visible; recent detail degrades as the run grows.                        |
| Fit, then follow past a resolution floor | Short runs fully visible; the floor is arbitrary.                                             |
| Shared scrollbar                         | One line, minimal; does not show where spikes are.                                            |
| Shared overview chart                    | Shows spikes; blends hosts with different scales.                                             |
| Per-host overview                        | Exact per host; one more line per host.                                                       |
| Overview as display only                 | One gesture set; distant spikes need zoom-out then zoom-in.                                   |
| Overview as navigation control           | Fast jumps to a seen spike; drag direction opposite to timeline drag.                         |

## Decision

The live view keeps its zoom and follows the newest sample. Each host gets a
one-line overview of its whole retained run under its timeline while part of
that history is outside the window; the window is shaded on it. Clicking the
overview centers the window there and pauses; dragging moves the window;
reaching the newest end resumes live. The rows layout has no overview. The
hover marker is a faint background tint behind the hovered cell, keeping the
bar's glyph and color.

## Consequences

Stacked blocks are 10 lines while the overview shows, so the stacked layout
falls back to rows sooner. Overview drag uses scrollbar semantics (drag right
moves toward newer), opposite to grabbing the timeline itself.
