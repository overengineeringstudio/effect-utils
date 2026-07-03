# 2026-07-03 — Metric-label enforcement blast-radius study (SC-DQ3 evidence)

Non-normative evidence for [.decisions/0008](../.decisions/0008-metric-label-privacy-enforcement.md).
Studied which real-world OTel metric-label cases the current + proposed enforcement excludes,
across effect-utils and the (private) fleet telemetry contract, to decide whether the strictness
is warranted.

## Hypothesis under test

The proposed "reject `redacted`-encoded metric labels" invariant closes a privacy gap; and the
existing high-cardinality metric-label rejection may be over-strict given a large telemetry disk.

## Method

Surveyed every first-party `OtelMetric.{counter,histogram,gauge}` + its labels in effect-utils
(the migrated seam contracts + `Metrics.ts` modules), and the fleet metric/label contract +
storage constraints in the private downstream repo (observability context, otel-stack modules,
Prometheus/Grafana/Alloy definitions). Read the `redacted` encode path in
`@overeng/otel-contract`.

## Results

- **`redacted` emits a constant mask.** `OtelAttr.encode('redacted')` encodes to the literal
  string `'<redacted>'`, never the secret value. A redacted attribute used as a metric label
  therefore emits a low-cardinality constant that leaks nothing — the proposed rule guards a
  non-threat, on the wrong axis (privacy is already handled by the encoder, not the label gate),
  and would only block a harmless (useless) case.
- **Cardinality cost is RAM/active-series bound, not disk bound.** Metric-label cardinality
  drives active-series count (Prometheus/Mimir), which is memory-limited; the large
  telemetry-storage disk does not relieve it. The premise that "big disk ⇒ high-cardinality
  labels are cheap" does not hold for metrics.
- **The fleet contract already mandates bounded-only labels.** First-party metrics use only
  `low`/`bounded` labels; high-cardinality identifiers (ids, request/run ids, keys, paths,
  versions) are kept as trace/log ATTRIBUTES, never metric labels; no secret is used as a label.
  So the existing author-time high-cardinality (+ `drop`) rejection matches the fleet's actual
  policy — it excludes no legitimate metric, only genuinely unbounded label dimensions.

## Conclusion

- **Drop the proposed `redacted`-label rule** — void (value is masked).
- **Keep the existing high-cardinality + `drop` gate** — warranted (RAM/series constraint,
  fleet-aligned), excludes no legitimate case.
- **Richer metric-label / privacy policy stays the consumer's semantic contract.**

→ SC-DQ3 resolved with zero code change (see 0008).
