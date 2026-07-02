# Semantic Conventions — Requirements

**Role:** This is the first genie **[generator](../requirements.md)**: it authors
OpenTelemetry **semantic-convention registries** in TypeScript and projects them to
[OTel Weaver](https://github.com/open-telemetry/weaver) v1 `groups:` YAML plus
multi-language bindings (TS/Rust/Effect), with Weaver as an additive validation/codegen
gate. It refines the shared generator contract ([../requirements.md](../requirements.md))
for the telemetry domain and inherits genie's [vision](../../vision.md); it states its own
role here rather than a separate vision.

## Context

- Refines the generators contract [../requirements.md](../requirements.md) (GEN-R01…R08):
  single source of truth, explicit derivation chain, multi-target projection, composition,
  validation gate.
- Builds on genie's [requirements.md](../../requirements.md) — the `GenieOutput`
  contract, read-only/freshness gates, isomorphic runtime builders, and the
  `@overeng/genie/composition` boundary ([genie spec §Composition Boundary](../../spec.md)).
- Provides the public MECHANISM that a private downstream consumer's telemetry semantic
  CONTRACT (attribute meaning, privacy / metric-label policy, its own vendor namespace)
  builds on. This subsystem owns the mechanism; the semantic contract is owned separately
  by that downstream consumer. Do not restate contract-level policy here — keep this
  mechanism-only.
- Consumes / conforms the existing runtime seam `@overeng/otel-contract` (the enforced
  `OtelAttr`/`OtelAttrs`/`OtelSpan`/`OtelMetric` DSL + the `no-raw-otel-primitives`
  oxlint rule).
- Supersedes an earlier downstream design note that had the registry authored directly in
  Weaver YAML: authoring is **TS-first**; Weaver YAML is generated. See
  [.decisions/0001](./.decisions/0001-ts-first-weaver-additive.md); amending that
  downstream note is a separate action in the consumer's own (private) repo.

## Assumptions

- **SC-A01 Weaver available & pinned:** the toolchain pins an exact Weaver version via a
  from-source flake (`nix/weaver-flake/`, currently v0.24.2, ahead of nixpkgs' 0.23.0);
  behavior was exercised on both 0.23.0 and 0.24.2 with no relevant drift. Weaver's v1
  `groups:` input is the stable contract; its CLI/resolved-schema are pre-1.0 and may churn
  (`resolve` is already deprecated — prefer `generate`/`package`).
- **SC-A02 otel-contract is the runtime seam:** all first-party spans/metrics/attributes
  are authored through `@overeng/otel-contract`, enforced by `no-raw-otel-primitives`.
- **SC-A03 Upstream semconv is a pinned, hermetic dependency:** first-party registries compose
  ON TOP of the upstream OTel semantic-conventions registry (`registry_path: …@vX.Y.Z[model]`),
  pinned to a version compatible with the pinned Weaver and materialized as a Nix FOD input so
  the gate runs against a local, deterministic, offline copy (no network at check time). See
  [.decisions/0007](./.decisions/0007-rust-target-and-first-consumer.md).
- **SC-A04 Composition is megarepo-wide:** registry fragments are contributed by
  multiple members (this public repo plus private downstream consumers) and aggregated into
  one registry, following genie's package/tsconfig composition idiom.

## Acceptable Tradeoffs

- **SC-T01 Weaver non-load-bearing:** Weaver's resolver/codegen/live-check are an
  additive gate, never on the critical path of producing runtime constants. Pre-1.0
  churn is absorbed by pinning + treating v1 `groups:` as the contract.
- **SC-T02 Generated YAML, not hand-authored:** humans author TS; the `groups:` YAML is
  a generated, read-only artifact. Reviewers read TS diffs, not YAML.
- **SC-T03 Conformance covers the intersection:** the registry↔otel-contract gate checks
  only attributes present in both surfaces (identity + cardinality + encode). Doc-only
  registry entries and runtime-only encoding logic are each valid on one side.

## Requirements

### Two layers (refines [GEN-R01/R02](../requirements.md))

- **SC-R00 Layer 1 = Weaver foundation; Layer 2 = Effect-Schema authoring:** the generator
  provides a Layer 1 foundation — a direct, faithful, standalone typed model of the Weaver
  `groups:` registry (attribute defs, signals, refs; → YAML) — and a Layer 2 whose idiom is
  **Effect Schema**: attributes are annotated Effect Schemas that project to the Layer 1
  registry AND derive the runtime encoder from one value. Layer 1 is usable standalone;
  Layer 2 is opt-in (per SC-R13's default stance).

### Authoring surface must be TS-first and typed

- **SC-R01 TS source of truth:** the registry (attribute catalog + signals) is authored
  in a typed TS DSL (Layer 1 directly, or Layer 2 which projects to it). No hand-authored
  `groups:` YAML.
- **SC-R02 Define-once / ref-only:** attributes are DEFINED once in a namespaced catalog;
  spans/metrics/events only REFERENCE and refine them (mirrors Weaver's registry split).
  Inline attribute definitions inside signals are rejected at author time.
- **SC-R03 Faithful weaver vocabulary:** the DSL expresses, and round-trips through
  Weaver, at minimum: primitive/array/`template[...]`/enum (`members`) types;
  `requirement_level` incl. the `{conditionally_required: …}` object form; `stability`
  (with deprecation ORTHOGONAL to stability, via the structured `deprecated:` object);
  `examples` (required on string attrs under Weaver `--future`); `note`, `brief`,
  `display_name`.

### Output must be a valid, deterministic Weaver registry

- **SC-R04 Weaver-valid:** the emitted registry passes `weaver registry check --future`
  (schema + shipped Rego policy) with zero violations.
- **SC-R05 Deterministic emit:** identical inputs produce byte-identical YAML
  (sorted, structurally serialized — not hand-built strings), satisfying genie's
  freshness/read-only contract.
- **SC-R06 Upstream composable:** the emitted manifest declares the upstream OTel semconv
  dependency so first-party signals can `ref` standard attributes (e.g.
  `http.request.method`) instead of redefining them.

### Registry must compose across megarepo members

- **SC-R07 Member fragments:** each member contributes its slice via a `*.genie.ts`
  exposing a registry fragment on the non-emitted `meta` channel (never by
  reverse-engineering emitted files), per genie's composition boundary.
- **SC-R08 Pure aggregation:** a root aggregator composes all member fragments into ONE
  registry via a filesystem-free projector over `meta` (dedup + deterministic sort),
  mirroring `aggregateFromPackages` / `tsconfigReferencesFromPackages`.
- **SC-R09 Whole-registry integrity:** cross-member ref integrity and namespace
  uniqueness are enforced at aggregation (they are not fully checkable per-member).

### Weaver must be an additive gate

- **SC-R10 Check gate:** a devenv/CI task runs `weaver registry check --future` on the
  composed registry; failure blocks.
- **SC-R11 Compatibility gate:** telemetry evolution is gated by `weaver registry diff
  --baseline-registry` and the shipped schema-evolution policies, treating the registry
  as a versioned public API.
- **SC-R12 Runtime conformance gate:** live emitted telemetry is validated against the
  registry via `weaver registry live-check` (OTLP), fed in tests by captured OTLP.

### Runtime seam must DERIVE from the registry (GEN-R03)

- **SC-R13 Registry is the single SSOT; runtime derives:** the registry catalog is the one
  authored source of attribute identity + policy + doc-metadata. The runtime encoders are
  DERIVED from it, not independently hand-authored: a catalog attribute is authored once
  and a signal composes catalog references, from which both the weaver group AND the
  runtime `OtelAttrs` encoder are produced. Per GEN-R03, derivation is the end state; a
  reconciling conformance check is only a migration bridge (SC-DQ5), not the resting state.
- **SC-R14 No lost runtime behavior:** the catalog is built ATOP `@overeng/otel-contract`'s
  primitives (`OtelAttr`/`OtelAttrs`), so the runtime encode/brand/decode-at-edge machinery
  is otel-contract's own code, reused verbatim — a strict superset. Product APIs
  (`OtelOperation`/`OtelMetric`, span.label enforcement, trusted-vs-validated increment)
  are re-pointed at catalog entries but keep their internals. Proven for the real restate
  contract (see [.experiments](./.experiments/2026-07-01-weaver-feasibility.md)). Fold depth
  is [.decisions/0002](./.decisions/0002-catalog-atop-otel-contract.md).
- **SC-R15 One namespaced key per concept, catalog-governed:** each concept has exactly ONE
  catalog entry with ONE namespaced dotted key (`restate.service`), referenced across all
  signals including metric labels (no per-context short-key aliases). The metric *wire*
  renders it via the default OTLP→Mimir mapping (`restate.service`→`restate_service`); dotted
  UTF-8 on the wire is a later opt-in, not required. See
  [.decisions/0003](./.decisions/0003-unified-full-dotted-keys.md); the transition for
  existing metrics is retention-first ([0004](./.decisions/0004-metric-label-migration.md)),
  folded into the authority-flip (SC-DQ5).
- **SC-R16 Contracts are discoverable via a registered seam:** every telemetry contract is
  reachable from a per-package registered seam (`defineOtelContract`, collected like
  `rootWorkspacePackages`), enforced by a lint that errors on any contract defined outside a
  seam. The seam is the single source for both the registry projection and the completeness
  sweep, so "no site missed" is structural, not audited. See
  [.decisions/0005](./.decisions/0005-contract-registration-convention.md).
