# Trace-derived metrics: a spanmetrics projection on `inspect`, reusing `otelite.metric/v1`

An instrumentation test often wants to assert RED facts (request rate, error
rate, duration distribution) about spans without the SUT _also_ emitting
metrics. otelite derives them from the captured trace, faithful to the OTel
collector-contrib spanmetrics connector so the numbers are portable and
recognizable.

## Decision

- **Surface:** a `--derive-metrics` modifier on `inspect --signal traces`. It
  emits derived metric rows instead of span rows; with `--summary` it emits the
  metric-summary rollup. One verb, the same source/stdin/filter machinery agents
  already use.
- **Shape:** reuse `otelite.metric/v1` (decisions/0012). `calls` is a monotonic
  `sum` row; `duration` is a `histogram` row. The derived histogram row **omits**
  `temporality` to stay byte-conformant with native histogram rows (delta is a
  fixed, documented semantic, not a per-row field); the `calls` sum row keeps
  `temporality: "delta"` since native sum rows already carry it.
- **Semantics (connector-faithful):** dimensions `service.name`, `span.name`,
  `span.kind`, `status.code`; proto-string enums (`SPAN_KIND_SERVER`,
  `STATUS_CODE_ERROR`); `duration` unit `ms` with the connector's default bounds
  `[2,4,6,8,10,50,100,200,400,800,1000,1400,2000,5000,10000,15000]`; a single
  **delta** snapshot over the bounded capture; errors are `calls` points with
  `status.code = STATUS_CODE_ERROR`.
- **Source:** the derivation reads the **raw** capture, because `otelite.span/v1`
  does not carry `span.kind` and the raw NDJSON does (integer enums per 0011).

## Why this is right

A prototype against a real capture (a controlled 14-span emitter across 2
services / mixed kinds / mixed statuses) produced `calls`/`duration` rows whose
key set is byte-identical to real `otelite.metric/v1` rows (save the one
histogram field above). RED assertions — `sum(calls)`,
`calls{STATUS_CODE_ERROR}/sum(calls)`, per-name duration buckets — are flat `jq`
one-liners, matching the dominant single-point agentic pattern that drove 0012.

## Rejected alternatives

- **A separate `otelite.trace-metric/v1` schema** — forks the metric contract,
  forces agents to learn a second shape, and duplicates the summarizer, all to
  avoid one absent field. Reuse wins (0012 consistency).
- **A dedicated `derive` verb / a `--signal trace-metrics`** — a third analysis
  verb fragments the surface; overloading `--signal` conflates input selection
  with transform. A modifier on `inspect --signal traces` keeps the axes
  orthogonal.
- **Cumulative temporality** — meaningless for a one-shot bounded capture; delta
  is what an assertion wants and what a single snapshot represents.

## Scope

v1: `calls` + `duration`, four default dimensions, default ms bounds, delta,
`--summary` rollup. Deferred: exemplars, configurable/extra dimensions,
configurable bounds/unit, the `events` metric, service-graph derivation, and
(optionally) adding `span.kind` to `otelite.span/v1`.
