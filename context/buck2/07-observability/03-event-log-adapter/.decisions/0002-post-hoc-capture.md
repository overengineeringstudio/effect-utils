# 0002 Post-Hoc Capture of the Explicit Event Log

Status: accepted

Accepted 2026-09-25 (decision q10; Johannes), on the capture-mode bakeoff
(B3) and overhead measurements (B4).

## Context

The adapter needs a capture mode: convert an invocation's log after Buck
exits, follow the log while the command runs, or wait for native OTLP export
upstream. Criteria: completeness on success/failure/cancellation/crash,
first-usable-span latency, shared-daemon correctness, operational risk,
maintenance.

## Evidence and Argument

- Post-hoc explicit capture is the only tested mode complete on every normal
  outcome: success 5/5; a failed build (exit 3) still yields a complete log
  and spans; two commands on one daemon keep distinct build ids and logs with
  no cross-contamination. Passive files cannot affect Buck — the lowest
  operational risk.
- Overhead is negligible: `--event-log` adds one byte-identical second write
  — +2.5–7 ms on ~25 ms no-op builds (statistically significant, the only
  resolvable effect) and mechanically < 10 ms / < 0.1% on working builds
  where ambient noise is 100× larger. Buck writes a default log anyway; the
  `BUCK_WRAPPER_UUID` propagates into filename and invocation record, making
  the invocation correlatable. Volume, not overhead, is the binding
  constraint (a warm one-file edit of the check aggregate still emits ~10 k
  spans; a cold CI run ~67 k).
- Live tailing (`log snoop`) works as a transport but is a console, not an
  event API; unattended streaming adds a second state machine (partial spans,
  reconnect, finalization, crash semantics) for latency no user need has yet
  justified. A hard client kill before the first event leaves no artifact at
  all — a boundary of the lazy writer, identical in every mode.
- Upstream PR #1370 exports one end-of-invocation wide-event span, is
  unmerged, and would require a custom binary — not the per-action path.

## Options

| Option                                     | Tradeoff                                                            | Outcome                           |
| ------------------------------------------ | ------------------------------------------------------------------- | --------------------------------- |
| Post-hoc explicit `--event-log` + build id | Complete, passive, low risk; latency = command end                  | Accepted                          |
| Live file tail                             | Lower span latency; a second state machine, partial-trace semantics | Not V1; revisit triggers recorded |
| Upstream native OTLP sink                  | No adapter work; one span, unmerged, custom binary                  | Rejected                          |

## Decision

Capture is post-hoc: traced callers pass an explicit per-invocation
`--event-log <path>` plus `--write-build-id`, correlated by the wrapper trace
id (01); conversion happens at ingest after the command exits. The native log
remains the source of truth after conversion. Live mode is revisited when a
product need requires spans during a running command, a seconds-scale partial
trace SLO appears, or a stable machine-readable follow API lands upstream.

## Consequences

- The capture side is effectively free and unconditional
  (BUCK.OBS.REC-R02); cost lives in conversion and storage (04, 05).
- Crash-before-first-event produces no artifact — accepted and documented,
  not a gap to engineer around.
- The revisit prototype sketch (sidecar tailing, completed-children-only
  emission, root held until result) is recorded in the capture-mode
  experiment.
