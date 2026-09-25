# Adapter implementation home — JSONL era (B2)

Date: 2026-09-25 · Same loaded host and corpus; n=7 serial per cell.

## Question

Before the decode-source flip, where should the production event-log → OTLP
converter live: TypeScript/Bun in `buck2-tools` (the validated 561-line
converter), a new Rust crate, or reuse of `otel-scrape` internals?

## Method

- Rust prototype (308 lines, serde_json + sha2) of the converter core running
  the same pinned `log show` and building the same trace/span identity,
  benchmarked against the validated TypeScript converter on the largest and
  median corpus logs (7 warm runs each), with structural equivalence checked
  independently (span counts, id sets, parent edges, v2 names, roots,
  orphans).
- Packaging and shipping surfaces read from the repository's existing
  producer paths (generated package trees, portable JS descriptors, the Rust
  product path, the Nix product bridge).

## Result

- TypeScript _won_ on wall time while doing strictly more work: 0.604 s vs
  0.725 s (largest), 0.160 s vs 0.186 s (median). Rust won on RSS: 250 MB vs
  316 MB (largest), 70 MB vs 100 MB (median). All absolute times sub-second.
- Structural equivalence exact on both inputs (12,622 / 3,549 spans, 0 id,
  parent, or name mismatches, 0 orphans); the Rust port omitted attributes
  by design.
- Shipping facts: TS portable bundle 20.6 KiB (a Bun-compiled standalone
  would be 81 MB); the Rust workspace already ships three-platform native
  products; `otel-scrape`'s exporter is private and wrapper-tailored — reuse
  means extraction, not a call.

## Conclusion

For the _JSONL_ source, TypeScript in `buck2-tools` was the right home —
correctness already validated, package is the semantic home, Vitest lane
exists. This conclusion was explicitly conditional: the direct-protobuf flip
(B2b, next record) reversed it. Recorded because the decision history
explains why two bakeoffs ran.

## VRS Impact

Superseded by [B2b](./2026-09-25-adapter-home-direct-decode-bakeoff.md); no
surviving requirement. Its durable finding: `otel-scrape` cannot be consumed
as an exporter library today — the dedicated-crate boundary in
[decision 0001](../.decisions/0001-direct-decode-rust-crate.md) follows.
