# History is a continuous timeline with compressed off gaps

Status: accepted

## Context

Restarting pingping discarded every probe outcome, so a new run could not show
whether an earlier outage or latency burst preceded the current observation.
A live bakeoff compared three presentations over the same retained journals.
Johannes selected A and approved production implementation, short-gap merging,
and this spec/decision update in `step-run/ask-dc579096e12b6400de270b626a677dc1/ask`.

## Evidence and Argument

The bakeoff showed restored outcomes alongside continuing live probes without
changing current-session statistics. Restarting a real run restored its journal.
Periods without a running observer must not be confused with failed probes or
pending replies; preserving their full wall-clock width would hide useful data.

## Options

| Option                                                      | Tradeoffs                                                                                              |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| A: continuous history with compressed off gaps              | Preserves the sequence across restarts and distinguishes observation gaps; chosen.                     |
| B: dim prior sessions separated by a current-session marker | Makes restart boundaries prominent rather than treating history as one observation sequence; rejected. |
| C: last-runs summary without old timeline samples           | Compact, but loses the timing and shape of prior loss/latency bursts; rejected.                        |

## Decision

Persist seven days of private per-host/per-session JSONL, restore at interactive
startup, and connect prior samples to the live run in a compressed history
overview. Current-session statistics and interactive chart controls remain
unchanged. Plain mode performs no history I/O; `--no-history` opts out in TTY mode.

An off gap of at least five seconds gets a fixed-width duration-labeled dashed
marker. Shorter gaps and overlapping sessions join seamlessly. Five seconds is
independent of the probe interval, so changing the live rate never changes how
old restart boundaries are interpreted. No presentation selector or synthetic
seeding CLI remains in the product.

## Consequences

Historical timing remains legible without implying that no observation means
packet loss. Compressed gaps are not to scale; run heights are independently
scaled. The historical overview is not hoverable or pannable, while the existing
current-run chart retains its interactions. Concurrent instances restore snapshots
and keep separate journals. File format and retention details live in the
[History specification](../spec.md#history-r07-r13-r21-decision-0006).
