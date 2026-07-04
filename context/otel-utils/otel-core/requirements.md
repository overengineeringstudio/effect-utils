# Requirements: otel-core

`otel-core` is the shared Rust primitive library of the `otel-utils` family: the
single owner of the primitives every bin composes. Role and composition are set
by the family docs — [../vision.draft.md](../vision.draft.md),
[../requirements.md](../requirements.md), [../spec.md](../spec.md). This subsystem
carries no vision; it refines the family requirements for the primitive library.

R-IDs are local to this document (they restart at R01); cross-document references
name the subsystem (e.g. "otel-core R01").

## Context

- Refines [../requirements.md](../requirements.md) R01/R02 (thin bins, single
  primitive owner) for the library itself.
- The primitive inventory and its single normative home are specified in
  [../spec.md](../spec.md#primitive-inventory); this document states the testable
  constraints on the library.
- Extraction source: `otel-scrape`'s private implementation
  ([../otel-scrape/spec.md](../otel-scrape/spec.md)) — CAS module, trace-context
  handling, wrap primitive, first-party exporter, span construction, trust gate.
- Reuses [../../content-address/requirements.md](../../content-address/requirements.md)
  (CAS contract) and the weaver `*.contract.ts` registries (telemetry
  vocabulary).

## Assumptions

- **A01 Second Rust consumer exists:** With `otel-wrap` (sessions) and
  `otel-scrape` both consuming it, `otel-core` is the second-Rust-consumer trigger
  that [../otel-scrape/.decisions/0009-rust-cas-module-boundary.md](../otel-scrape/.decisions/0009-rust-cas-module-boundary.md)
  named for promoting the Rust CAS out of a wrapper-private module.
- **A02 Weaver Rust encoder is available:** The weaver-native primitives
  (exporter, span model with vocabulary, trust gate) depend on the generated
  typed Rust encoder (family decision 0003).

## Acceptable Tradeoffs

- **T01 Layered extraction:** Registry-agnostic primitives (CAS, trace-context,
  wrap) are extractable independently of the weaver-native primitives (exporter,
  span-model vocabulary, trust-gate), which depend on the generated encoder. This
  is a dependency ordering, not a schedule.
- **T02 Rust realization, TS contract shared upstream:** `otel-core` supplies the
  Rust CAS realization while `content-address`'s contract stays top-level and its
  TS package stays the reference implementation — two implementations bound by
  the shared contract and conformance vectors.

## Requirements

### Primitive ownership

- **R01 Single owner:** `otel-core` is the one owner of the family primitive
  inventory (wrap primitive, span model, exporter + serializer seam, mint/join
  precedence, trust-gate, CAS realization, build-id, state-dir contract,
  trace-url surfacing, re-render mechanism). Each primitive has one normative
  home in [../spec.md](../spec.md#primitive-inventory).
- **R02 Registry-agnostic:** The exporter and span model take attributes as data
  and MUST NOT bake in a bin's telemetry registry (family decision 0002). A
  producer supplies its own vocabulary at its call sites.

### Wrap primitive

- **R03 Passthrough + disabled transparency:** The wrap primitive preserves the
  child's stdout/stderr/exit and, with no telemetry configured, is
  indistinguishable from direct execution. These are invariants inherited by
  `otel-wrap` and `otel-scrape`.
- **R04 Context export:** The wrap primitive exports active context to children
  (`TRACEPARENT`, and `OTEL_TASK_TRACEPARENT` for task-parented sub-span
  emitters) so nested bins re-parent correctly.

### Context + exporter

- **R05 One mint/join precedence:** `otel-core` owns the single root-or-join
  precedence rule; both `otel-wrap` and `otel-scrape` consume it, so their root
  behavior cannot diverge (family requirement R14).
- **R06 First-party exporter behind a seam:** `otel-core` provides the first-party
  OTLP/HTTP-JSON trace exporter behind a serializer seam admitting a later
  `opentelemetry-otlp` adoption (family decision 0004). Export failures are
  degraded evidence that never change child behavior.
- **R07 Weaver-native encoding:** The exporter encodes attributes through the
  generated typed Rust encoder (family decision 0003); it does not hand-roll OTLP
  attribute encoding, and the encoder's privacy policy is enforced at encode
  time.

### State + identity

- **R08 CAS realization mirrors the contract:** The CAS primitive mirrors the
  `content-address` descriptor / object-path / `cas:` URI / manifest / pin
  contract, carries conformance vectors, and does not fork it.
- **R09 State-dir contract:** `otel-core` owns the one state-dir contract holding
  two passive stores, `cas/` (content-addressed, immutable) and `sessions/`
  (identity-addressed, mutable open spans). No daemon (family decision 0007).
- **R10 Persisted open span:** The span model is reusable as a persisted open span
  in `sessions/`, so a root can be opened in one process and closed in another
  without a resident holder.
- **R11 Build-id:** `otel-core` owns one build/version identity primitive stamped
  on emitted telemetry, shared across bins rather than per-bin version strings.

### Public safety

- **R12 Trust-gate primitive:** `otel-core` owns the public-safe-by-default trust
  gate: public-safe identity + hashes always; raw argv/cwd/local paths only into
  an explicitly asserted-private named sink; credentials and payloads never. Every
  bin's sinks inherit it.
- **R13 Terminal-only surfacing:** Trace-url surfacing and adapter re-render are
  terminal-only (stderr); the terminal is not a sink, so surfaced/rendered text
  never enters the summary or OTLP export.
