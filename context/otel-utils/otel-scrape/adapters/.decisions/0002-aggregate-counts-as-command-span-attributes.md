# 0002 - Aggregate counts as command-span attributes

Status: accepted

## Context

Adapters derive run-level aggregate counts (oxlint diagnostics total, deadnix
findings total, pnpm packages resolved/downloaded, store-hit ratio). The
classification ladder maps such counters to the Metric kind. But the current
implementation writes adapter metrics to the summary and **drops them from OTLP
export** (`lib.rs` `otlp_span_events` no-ops `AdapterOutput::Metric`), pending a
resolution of how adapter metrics map to OTLP metric points (fleet DQ1). As a
result, count-only adapters (deadnix) and the count portion of phase adapters
(pnpm) contribute nothing to the trace today.

## Evidence and Argument

The classification ladder has a distinct row: "Counter or aggregate statistic →
Metric", but an aggregate statistic is equally a legitimate **span attribute**
on the span whose work it summarizes. oxlint's review surfaced this (DQ-oxlint-1):
attaching `diagnostics=N`, `errors=N`, `warnings=N` to the oxlint command span
would surface counts in the trace immediately, within the ladder, and sidesteps
the unresolved metric-point question. The same shortcut generalizes: pnpm's
`packages_downloaded` / `store_hit_ratio` and deadnix's `findings` are natural
attributes of their command spans.

This is not a replacement for real metrics — a fleet-wide count over many runs
still wants metric points (DQ1). It is the representation that makes the common
case trace-visible now without over-committing.

## Options

| Option                                                              | Consequence                                                                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Block count surfaces until adapter-metric OTLP semantics land (DQ1) | deadnix ships with nothing in OTLP; pnpm loses its store-hit signal; fleet stalls on an unrelated question.         |
| Emit aggregates as command-span attributes now                      | Counts reach OTLP within the ladder; DQ1 can still add metric points later without rework of the attribute surface. |
| Emit per-item events only, no aggregates                            | Consumers re-aggregate from events; lossy under sampling and noisier.                                               |

## Decision

An adapter MAY attach its run-level aggregate counts to the wrapper command span
as attributes under the `otel_scrape.adapter.<tool>.*` namespace (public-safe
per R27: counts and ratios only, never identities). These attributes are
generated-registry entries like any other telemetry constant (parent decision
[../.decisions/0004-generated-telemetry-registry.md](../.decisions/0004-generated-telemetry-registry.md)).
The existing summary metric is retained; the span attribute is the OTLP-visible
form until DQ1 resolves.

## Consequences

- deadnix's `findings` count and pnpm's `packages_downloaded` / `store_hit_ratio`
  become trace-visible without waiting on DQ1 (unblocks ADP-R04 rankings).
- oxlint MAY adopt `diagnostics` / `errors` / `warnings` span attributes as a
  low-risk enhancement (its deferred enhancements #1/#2 become shippable via this
  path rather than as OTLP-dropped metrics).
- Registry gains `otel_scrape.adapter.<tool>.<count>` attribute entries per
  admitted count-bearing adapter.
- DQ1 remains open for true cross-run metric aggregation; this decision does not
  close it, only unblocks the per-run trace surface.
