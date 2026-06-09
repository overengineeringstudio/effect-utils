# M6 metric/log inspect shape: per-data-point rows + rich summary (eval-chosen)

The metric/log `inspect` output shape (no otel-cli precedent — net-new) was
chosen empirically: three candidate shapes were each implemented and scored by
writing the real `jq` assertion a coding agent would for 21 agentic scenarios
against a real otelite-captured corpus (`tmp/otelite-m6-eval/`).

## Result

| Shape                                        | Score /42 | Verdict                                        |
| -------------------------------------------- | --------- | ---------------------------------------------- |
| **A — per-data-point rows + rich summary**   | **40**    | winner                                         |
| B — per-metric, nested data points           | 35        | single-point filters need a data-point descent |
| C — lean (no histogram stats / no trace ids) | 23        | 7 scenarios impossible                         |

Single-point filtering ("the counter for status 500", "the /checkout max", "the
gauge value") is the dominant agentic pattern; per-data-point rows make it a flat
`.attrs.x == v` one-liner. C confirmed the floor: dropping histogram stats + trace
ids makes bread-and-butter scenarios impossible for a tiny field saving.

## The shape (golden-locked)

- `otelite.metric/v1` — one row per data point: `{schema, service, name, type,
unit, attrs, time_unix_nano, start_time_unix_nano}` + type-specific: gauge/sum
  `value` (sum also `monotonic`, `temporality`); histogram `count, sum, min, max,
mean, bucket_counts, explicit_bounds`; exphistogram `count, sum, scale,
zero_count, positive_buckets, negative_buckets`.
- `otelite.metric-summary/v1` — per-name `{name, type, unit, data_points,
services}` + (gauge/sum only) `value_min/value_max/value_sum` + totals.
- `otelite.log/v1` — one row per record: `{schema, service, scope,
severity_number, severity_text, body, trace_id, span_id, time_unix_nano,
attrs}` (trace_id/span_id null when absent).
- `otelite.log-summary/v1` — `{total, by_severity, by_service}`.

Refinements folded from all three evaluators: sum `monotonic`/`temporality`
(closes the one A gap), derived histogram `mean`, and value stats restricted to
gauge/sum in the summary (a footgun on histogram rows).

## Implementation constraint

`opentelemetry-proto` `with-serde` **deserialize** drops the
`exponentialHistogram` data oneof, so inspect walks the captured `serde_json::Value`
directly (not via the proto type) — otherwise it would silently lose exp-hist it
captured. exp-histograms only survive the **protobuf** receive path at all
(JSON-receive drops them); see the follow-up issue.
