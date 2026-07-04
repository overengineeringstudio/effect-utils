# 0003 — Weaver-native telemetry mandate

**Status:** Accepted.

**Context:** The family is a fleet of Rust telemetry producers (`otel-core`,
`otel-wrap`, `otel-scrape`, the nix adapter). The OTEL semconv weaver system is
the authored SSOT for telemetry vocabulary (`*.contract.ts` seams; SC-R13:
registry is the single SSOT and runtime encoders derive from it). But that
derivation guarantee is TS-only: weaver's Rust target emits **names only**
(`constants.rs` = `pub const … : &str`), so Rust producers hand-roll OTLP
attribute encoding, and conformance is caught only at runtime by
`weaver registry live-check`. Hand-rolled encoders also hand-maintain privacy
policy (e.g. the nix substituter-hostname `encode:'drop'`), which drifts from the
authored `overeng_policy` annotations.

**Decision:** All family telemetry is authored as weaver `*.contract.ts` seams;
no bin defines a bespoke registry or hand-authors attribute-key literals. Rust
producers consume generated `constants` **and a new generated typed Rust
encoder** derived from the registry. Improving the weaver Rust target to emit
that typed encoder is an explicit family goal, not an external dependency: the
family is the forcing function that closes the Rust side of
`overengineeringstudio/effect-utils#882` and extends SC-R13's runtime-derivation
guarantee to Rust.

The generated encoder carries the registry's `overeng_policy` privacy
annotations, so a `drop`/gate decision authored once in the seam is generated
into every producer rather than hand-maintained per call site.

**Consequences:**

- Rust producers stop hand-rolling OTLP encoding; conformance is a
  compile/codegen property, not only a runtime live-check.
- Privacy policy travels from the seam into the encoder, so public-safety is
  enforced by generation, not discipline.
- The weaver-native exporter (decision 0004) consumes the generated encoder;
  this decision absorbs the Rust-encoder side of the `#882` epic as family scope.
- This governs _authorship_ of vocabulary; it is compatible with the
  registry-agnostic core (decision 0002), which governs where vocabulary lives
  relative to the exporter. Different altitudes.
