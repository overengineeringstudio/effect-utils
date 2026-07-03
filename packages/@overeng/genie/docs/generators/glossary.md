# Generators — Glossary

Terms shared across generators. Inherited downward by each generator child.

- **Generator** — a genie artifact domain that projects, from typed TS, validated
  multi-language bindings. Built as two layers (Layer 1 + Layer 2), plus provenance,
  composition, and a validation gate.

- **Layer 1 (foundation)** — a generator's direct, faithful, unopinionated, typed 1:1
  model of its target domain's own vocabulary. Dependency-light, projects deterministically
  to output/bindings, and usable STANDALONE. The mechanism of record.

- **Layer 2 (composition)** — a generator's opt-in opinionated authoring layer on top of
  Layer 1: composition/aggregation helpers, higher-order combinators, or a domain idiom
  (the semantic-conventions generator's is an Effect-Schema authoring surface). Can derive
  multiple artifacts from one authored value. Always projects DOWN to Layer 1; never
  bypasses it. _Avoid_: equating Layer 2 with Effect Schema (that's one flavor) or treating
  it as mandatory — Layer 1 stays a first-class authoring surface.

- **Source of truth** — the single authored artifact (at whichever layer) for a given
  target; other representations derive from it. _Avoid_: a second hand-authored surface
  kept in sync by a check (that is a migration bridge at most).

- **Layer 1 model** — the faithful domain model Layer 2 projects into, and from which all
  bindings render. (For the semconv generator: the resolved Weaver registry data.)

- **Binding / target** — a generated, read-only, language-specific representation of the
  source (TS constants, Effect Schemas, Rust structs, an external tool's registry).

- **Derivation chain** — the explicit `source → resolved model → binding` path. The unit
  of "clean derivation": no step duplicates a fact from an earlier step.

- **Migration bridge** — a temporary reconciling check between the source of truth and a
  pre-existing hand-authored surface, used only while migrating that surface onto
  derivation. Not a resting state.

- **Provenance / fingerprint** — the `source: <path>` + `sha256:<hash>` header on each
  binding that makes staleness visible in normal repo checks.

- **Additive gate** — a validation step (possibly an external tool) that can fail a build
  but is never required to produce the bindings.
