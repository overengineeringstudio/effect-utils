# 0001 — Family composition: thin bins over otel-core

**Status:** Accepted.

**Context:** Command wrapping, root/session minting, build-tool observation, and
local capture each grew as a separate tool with its own exporter, context
handling, and identity model. The same primitives — OTLP export, a span model,
traceparent mint/join, content-addressed artifacts — were re-implemented per
tool. There was no single home for the shared mechanics and no single statement
of how the tools compose at their seams.

**Decision:** Structure the OTEL tooling as one family, `otel-utils`, built from
a shared Rust library `otel-core` plus thin role bins:

- `otel-core` is the single owner of the shared primitive inventory (wrap
  primitive, span model, exporter + serializer seam, mint/join precedence,
  trust-gate, CAS realization, build-id, state-dir contract, trace-url
  surfacing, re-render mechanism).
- `otel-wrap`, `otel-scrape`, and `otelite` are thin compositions over
  `otel-core`. Each owns a role surface (CLI verbs, adapter registry, receiver)
  and MUST NOT re-implement a primitive `otel-core` owns.

`otel-core` is extracted from `otel-scrape`'s private implementation: the CAS
module, trace-context handling, and wrap primitive are registry-agnostic and
extract cleanly first; the exporter, span model, and trust-gate fold in
weaver-native (they depend on the generated Rust encoder, decision 0003). The
extraction is a capability-layering, not a schedule: a primitive lands in
`otel-core` when it is needed by a second consumer and its dependencies (the
encoder for the weaver-native ones) are available. The family (otel-core + the
otel-wrap sessions consumer) is exactly the "second Rust consumer" that
[otel-scrape decision 0009](../otel-scrape/.decisions/0009-rust-cas-module-boundary.md)
named as the trigger to promote the Rust CAS out of a wrapper-private module.

**Consequences:**

- One coherent contract and no per-tool re-implementation, at the cost of
  coupling the bins to one `otel-core` version (accepted, requirement T01).
- The Rust package boundary follows the existing `otelite`/`otel-scrape` pattern
  (committed Cargo metadata, package-local Nix build, flake outputs, devenv
  gates).
- The `content-address` contract stays top-level and domain-general; `otel-core`
  supplies only the Rust realization (decision does not absorb the contract).
- A bin that needs a new shared mechanic adds it to `otel-core`, not a private
  copy (requirement R14).
