# Semantic Conventions — Glossary

Terms this subsystem introduces. Inherits genie's glossary; contract-level terms
(privacy, cardinality tiers, metric-label policy) come from each downstream consumer's own
semantic contract.

- **Semantic-convention registry** — the versioned catalog of attributes + signals that
  defines our telemetry's public API. The source of truth, authored in TS.

- **Weaver** — the OpenTelemetry Rust CLI that checks, resolves, diffs, generates from,
  and live-checks a semantic-convention registry. Used here as an additive gate.
  _Avoid_: "the linter" (it is more; and it is not on the runtime path).

- **Registry fragment** — one member's contributed slice of the registry (its namespaced
  attribute catalog + signals), carried on the genie `meta.registry` channel.

- **Catalog / attribute definition** — an attribute DEFINED once under `registry.<ns>`,
  carrying its type, stability, brief, examples, and policy. _Avoid_: defining
  attributes inside a signal (rejected).

- **Signal** — a span, metric, or event group. Signals REFERENCE catalog attributes;
  they never define them.

- **Ref / refinement** — a signal's reference to a catalog attribute (`ref:`), optionally
  refining its `requirement_level`, `note`, or `sampling_relevant` in that context.

- **`groups:` YAML** — Weaver's v1 registry input format (the stable contract). Generated
  from the TS DSL, read-only. _Avoid_: the pre-1.0 `definition/2` format (not targeted).

- **Additive gate** — a validation/codegen step that can fail a build but is never a
  dependency of producing runtime artifacts. Weaver's role here (SC-T01).

- **Conformance check (migration bridge)** — a TRANSITIONAL genie gate enforcing that a
  not-yet-migrated `@overeng/otel-contract` site agrees with the registry (present, matching
  cardinality + encode). It exists only while legacy hand-authored sites are migrated onto
  the derived catalog; it is removed per namespace as they move over. It is NOT the
  end-state mechanism — the end state is derivation (the runtime encoder is produced from
  the catalog).

- **Conformance completeness** — the property that the bridge check covers EVERY
  not-yet-migrated otel-contract site. An incomplete sweep silently misses drift; it is
  guaranteed structurally by the registered seam — a no-orphan-seam aggregator check plus the
  seam-file lint ([.decisions/0005](./.decisions/0005-contract-registration-convention.md)).

- **Derivation** — the end-state relationship: the runtime encoder (`OtelAttrs`/`OtelMetric`/
  `OtelOperation`) is produced FROM the catalog, so there is no second authored surface to
  keep in sync.

- **Upstream dependency** — the pinned OTel semantic-conventions registry declared in the
  manifest (`@vX.Y.Z[model]`), whose attributes first-party signals may `ref`.
