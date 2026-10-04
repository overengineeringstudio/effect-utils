# Experiment J: Mixed host-probe and Effect application seam

Non-normative findings from a supplied private responsibility-classification study. No whole-product rewrite was performed or approved by this experiment; private application identities and locations are omitted.

## Question

Does a fast native host-command slice justify replacing a larger schema-rich review application, or only identify a separable host-probe seam?

## Hypothesis

Rust can improve startup for deterministic host probes while existing Effect ingestion, authored contracts, and React review presentation remain a useful application boundary.

## Method

Compare a real Rust host-daemon probe with a simplified bundled Effect implementation, sharing one Effect-owned configuration/job schema and generated Rust consumers. Build both from source through Nix and execute validation plus actual daemon calls, not empty startup alone. Verify local Rust, Effect source/bundle, and both Nix-built engines against shared vectors and external failures. Installed larger-command controls are measured separately and are not contract-equivalent to the slice.

## Result

Final Hyperfine delivery measurements use three warmups and 20 runs, mean ± sample SD:

| Matched slice | Rust | Bundled Effect |
| --- | ---: | ---: |
| Help | 1.10 ± 0.48 ms | 433.3 ± 103.5 ms |
| Configuration/job validation | 13.2 ± 3.2 ms | 441.7 ± 118.7 ms |
| Real daemon probe | 132.2 ± 104.6 ms | 497.8 ± 147.9 ms |

The real daemon call alone measured 67.7 ± 43.0 ms. The installed complete probe did more work and measured 956.3 ± 193.2 ms; that is not a whole-product Rust speedup ratio. Runs were sequential on a saturated, non-stationary host: load1 changed 164.96→206.31. Do not subtract sample means to attribute exact layer costs.

A concrete owner/export mismatch mattered independently of speed: an unbounded positive Effect Int exported no maximum, letting generated Rust accept 9,007,199,254,740,992 and 9,223,372,036,854,775,807 when Effect rejected them. Repairing the single owner restored parity; no Rust mirror special case was added. Five engines then agreed on 23 job vectors and normalized daemon results, including safe-integer boundaries, whitespace, tags, and accept-and-ignore unknown-field semantics. Three external failure scenarios per engine also passed. An initial Nix Rust runtime closure accidentally retained vendored dependencies and was repaired in the scratch build.

## Conclusion

The study supports a mixed seam: deterministic host-state probes are native candidates at a substantive migration trigger; current ingestion/review behavior, authored contract registry, and React presentation remain Effect-owned application work. A coarse process request/result is the simplest proven probe boundary. Metadata loading did not prove a dynamic callback/plugin ABI, and faster help did not prove complete state/history/retention or UI replacement.

## Intent Impact

Use responsibility and measured workload evidence rather than executable-name or dependency-presence labels. Preserve one schema owner and generated consumers. No blanket rewrite follows; whole-component cutover needs separate history, persistence, cancellation, output/exit, telemetry, and presentation parity proof.

## Limits and sources

The report proposes classifications, not adopted product decisions. No complete native review/TUI/ingestion artifact or controlled agent-productivity trial was measured. A shared CLI/RPC/web application provided actual Effect reuse in another inspected component; a small REST adapter did not establish the same exception merely by importing HttpClient/Schema. These responsibility observations are not private product migration commitments.

- Supplied private J report: matched delivered slice, schema failure, five-engine verification, and mixed-seam/no-rewrite findings. All private identities, hosts, and artifact locations are omitted.
- [Public schema-interop context](https://github.com/Effect-TS/effect/issues/8690) and [earlier conformance evidence](./e2-schema-conformance.md), relevant to the owner/export hazard but not public sources for J's private benchmark.
