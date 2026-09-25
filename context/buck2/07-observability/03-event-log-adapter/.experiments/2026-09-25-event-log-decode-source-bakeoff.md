# Event-log decode source bakeoff (B1)

Date: 2026-09-25 · Loaded 32-core fleet dev host (load1 33–65, per-run values
in raw data); n=7 + 1 warmup per cell; corpus of 22 real logs (7 local, 15
cold CI; 47.3 MB uncompressed, 189,114 records; all written by the pinned
unstable-2026-09-01 Buck).

## Question

Which decode source should the adapter use for `*_events.pb.zst`: (a)
`buck2 log show` JSONL (the scratch converter's path), (b) direct
protobuf+zstd decode pinned at the fleet's Buck release, or (c) another
stable machine surface (chrome-trace, what-ran, critical-path JSON,
invocation-record)?

## Method

- Framing established from upstream source at the pinned binary's commit and
  validated schema-free on all 22 logs (generic wire walk): one zstd stream,
  varint length-delimited records, `Invocation` header + N events + exactly
  one `CommandResult`.
- Benchmark matrix on the largest CI log (711,142 B compressed / 7.29 MB /
  25,562 records / 12,622 spans) and the corpus median: zstd floor CLI, `log
show`, the scratch Bun pipeline, a Rust direct decoder (prost + protox, no
  protoc; zstd static; 2.5 MB binary), and `chrome-trace`.
- Field-completeness audit against the converter's needed-field list, per
  source, with per-field corpus hit counts.
- Version fragility: three binaries spanning five months (04-15, 08-22,
  09-01) reading each other's writer logs (15 combos), plus proto diffs per
  hop; truncation tolerance by cutting a corpus log at 60–69%.

## Result

- Decode (largest log, median / peak RSS): direct 42.0 ms / 13.7 MB; `log
show` 59.0 ms / 36.3 MB; scratch pipeline 190.8 ms / 96.0 MB (JSONL for
  this log is 16.35 MB — 2.24× the uncompressed protobuf); chrome-trace
  94.3 ms / 45.7 MB; zstd floor 11.8 ms / 14.2 MB. Direct ≈ 165 MB/s warm;
  22 logs in 343 ms in one process (~138 MB/s).
- Completeness: direct is a strict superset of `log show` (same bytes,
  typed) and folds the critical path in-band (`critical_path2` present in
  22/22 logs, incl. April-written ones) — the second critical-path
  subprocess disappears. chrome-trace keeps 992 of 12,622 spans (collapsed/
  sampled, no metadata/digests); what-ran is command-level; critical-path
  JSON has no span tree; invocation-record is aggregate-only and must be
  requested at invocation time.
- Fragility: structural compatibility perfect in all 15 reader×writer
  combos, but semantic drift is real — `ActionExecutionEnd` field 30/36
  changed `bool did_cache_upload → enum cache_upload_result` between April
  and August; an old binary's JSONL drops the new key and renders any
  `UploadResult ≥ 1` (including `NOT_ATTEMPTED`) as `true`. Proto drift was
  field-number-additive across the window, but types at stable numbers
  changed. The direct decoder (one pinned proto) read all 22 corpus logs +
  all three writer versions with zero errors, unknown fields skipped.
- Truncation: both `log show` and direct exit 0 with every complete record
  (12,087 of 16,526 at a 60% cut); direct mirrors upstream's
  tolerant-of-truncation semantics.

## Conclusion

Direct decode is the adapter's primary source (4.5× faster, 7× less memory
than the scratch pipeline; no 136 MB binary dependency; explicit auditable
pin); `log show` stays as fallback (matching binary, alert on mismatch) and
for one-off debugging; unknown fields count as recorded data loss; the
(c)-family surfaces are never span sources. Confidence: high on performance
and completeness, medium-high on fragility (five months × three binaries is
a narrow window; upstream promises nothing).

## VRS Impact

Settled [BUCK.OBS.ADP-R01..R04](../requirements.md) and
[decision 0001](../.decisions/0001-direct-decode-rust-crate.md) (q10). The
type-diff bump rule (BUCK.OBS.ADP-R03) exists because of the measured retag.
What would change it: upstream-native OTLP, a framing change, a diverging
producer fleet, or a sub-ms live-tailing requirement.
