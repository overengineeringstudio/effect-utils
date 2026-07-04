# Open Questions: otel-utils (family)

Unresolved family-level design questions. Each links a `spec.md` DQ. A question
exits this file when resolved — into the spec as a decision or into an
experiment as a tested hypothesis.

## DQ1 — nix adapter namespace

Links [spec.md DQ1](./spec.md#open-design-questions).

**Question.** When the `nix` adapter lands in `otel-scrape` (superseding
`nix-trace`), what telemetry namespace does its span-forest carry?

**Constraint.** The `nix.*` namespace is already owned by
`packages/@overeng/megarepo/src/nix.contract.ts` — an attrs-only weaver seam
where every `nix.*` key reaches telemetry through a nix bridge span. SC-R09
(whole-registry integrity) enforces namespace uniqueness at registry
aggregation, so the adapter cannot independently re-declare `nix.*`.

**Options.**

- **Extend the existing seam.** The adapter authors its span-forest attributes
  into `nix.contract.ts`, reusing existing keys (`nix.flake.*`, `nix.lock.*`) and
  adding build/derivation keys there. One owner, one namespace; couples the
  adapter to the megarepo contract seam.
- **Distinct namespace.** The adapter takes its own namespace (e.g.
  `nix.build.*` authored as a separate seam member, or a non-`nix` prefix),
  keeping the megarepo seam untouched. Avoids coupling; risks two overlapping
  nix vocabularies.

**Resolves when.** The nix adapter's attribute set is authored against a weaver
seam and the SC-R09 uniqueness gate passes on the composed registry.

## DQ2 — metrics/logs coverage

Links [spec.md DQ2](./spec.md#open-design-questions).

**Question.** Traces are the primary signal. Does the exporter's serializer seam
plus the weaver Rust encoder leave room for metrics and logs, or will they force
a second seam?

**Constraint.** The hot path is a first-party OTLP/HTTP-JSON _trace_ exporter;
the serializer seam exists so `opentelemetry-otlp` (metrics/logs, protobuf) can
slot in later without a rewrite. The generated Rust encoder currently targets
attribute encoding for spans.

**Resolves when.** One metric or one log signal is encoded end-to-end through the
serializer seam and the generated encoder, confirming (or falsifying) that no
second seam is needed.
