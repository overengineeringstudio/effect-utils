# Generators — Requirements

**Role:** This subsystem defines the shared contract for genie **generators**: genie
artifact domains that project, from a typed TypeScript source, validated **bindings** in
multiple languages, kept honest by genie's freshness/read-only gates plus a domain
validator. It is a composite node: it owns the cross-generator mechanism — including the
**two-layer architecture** every generator follows — and each generator (a numbered child)
refines it for its domain. It inherits genie's [vision](../vision.md) and
[requirements](../requirements.md).

Children:

- [01-semantic-conventions/](./01-semantic-conventions/spec.md) — OpenTelemetry
  semantic-convention registries via OTel Weaver (the first generator).

## Context

- Builds on genie's [requirements.md](../requirements.md) — the `GenieOutput` contract,
  `meta`-channel composition, read-only + freshness gates, and the isomorphic
  runtime-builder boundary.
- Generalizes patterns already emerging in the repo: the `projection-artifact` runtime
  builder (typed `data` → deterministic projected output + `schemaVersion` + validators),
  and the in-flight otel-scrape telemetry-registry generator, which asked for exactly this
  "shared contract-generation infrastructure." Generators is that shared home; other
  registry generators are expected to converge onto it (we lead; they follow).

## The two-layer architecture (the organizing principle)

Every generator is built as **two layers**. This is not a new invention — it names a split
genie's existing artifact builders already have (a thin, faithful data-model builder, plus
opinionated composition helpers behind the `@overeng/genie/composition` boundary). The
generators family makes that split explicit and universal:

```
 Layer 2 — Composition (opinionated, ergonomic, OPT-IN)
   opinionated helpers on top of Layer 1 that embrace OUR idioms as fits the domain:
   composition/aggregation, higher-order combinators, and single-source derivation of
   MULTIPLE artifacts from one authored value. The specific idiom varies per generator
   (see table). Projects DOWN to Layer 1; never bypasses it.
        │  projects to
        ▼
 Layer 1 — Foundation (direct, faithful, unopinionated, STANDALONE)
   a complete, typed 1:1 model of the target domain's own vocabulary. Plain data → output.
   Dependency-light. Usable on its own for full control / decoupled / hand-tuned cases.
```

The two-layer shape recurs across genie, which is why it lives here once:

| Generator / builder | Layer 1 (foundation) | Layer 2 (opinionated composition) |
| --- | --- | --- |
| package.json | the package.json data model | `catalog.compose`, `aggregateFromPackages` |
| tsconfig | the tsconfig data model | `tsconfigReferencesFromPackages` (meta-projected refs) |
| github-workflow | the workflow data + YAML | higher-order step/job helpers/decorators |
| semantic-conventions | the Weaver `groups:` registry model | **Effect-Schema authoring** (one flavor — attributes as annotated Schemas that derive both the registry and the runtime encoder) |

Layer 1 is the escape hatch and the mechanism of record (drop to it when the opinionated
layer doesn't fit); Layer 2 is the ergonomic default that makes the common case a joy.
**Effect Schema is the semantic-conventions generator's Layer 2 — it is an example, not the
definition.** A future generator's Layer 2 may be composition helpers, a builder DSL, or
anything that fits its domain.

## Assumptions

- **GEN-A01 Typed TS authoring:** every generator's authored source is typed TypeScript
  (not hand-authored YAML/JSON), consistent with genie's model.
- **GEN-A02 Multi-language consumers:** bindings are consumed from more than one language
  (at least TypeScript and Rust) and from Effect-idiomatic TypeScript.
- **GEN-A03 Composition is megarepo-wide:** a generator's source may be contributed by
  multiple members and aggregated, per genie's composition boundary.

## Acceptable Tradeoffs

- **GEN-T01 Generated bindings are read-only:** humans author TS; all bindings are
  generated, read-only, drift-gated. Reviewers read the TS source diff.
- **GEN-T02 Two layers, not one:** we accept maintaining a Layer 1 foundation AND a Layer 2
  composition surface (rather than a single blended API), because the standalone foundation
  is what keeps the opinionated layer optional and prevents lock-in to one authoring style.

## Requirements

### Two-layer architecture

- **GEN-R01 Layer 1 foundation:** every generator provides a direct, faithful, typed model
  of its target domain's own vocabulary that projects deterministically to the output. It
  is COMPLETE (covers the target vocabulary), STANDALONE (usable without Layer 2), and
  dependency-light (no opinionated framework dependency such as Effect Schema).
- **GEN-R02 Layer 2 composition (opt-in):** a generator MAY provide an opinionated
  composition layer for ergonomic authoring and single-source multi-artifact derivation.
  The idiom is generator-specific (composition helpers, higher-order combinators, an
  Effect-Schema authoring surface, …) — Effect Schema is one example (the
  semantic-conventions generator's), not a requirement. Layer 2 MUST project down to Layer
  1 (it may not emit output by bypassing the foundation), and using it MUST be optional —
  Layer 1 remains a first-class authoring surface.

### Single source, clean derivation

- **GEN-R03 One authored source per artifact:** whatever layer is used, a given artifact
  has one authored source; other representations derive from it — no second hand-authored
  surface manually kept in sync.
- **GEN-R04 Explicit derivation chain:** the path source → resolved model → binding is an
  explicit, inspectable projection, documented in the generator's spec.

### Deterministic, multi-target projection

- **GEN-R05 Deterministic emit:** identical source → byte-identical bindings (sorted,
  structurally serialized), satisfying genie's freshness/read-only contract.
- **GEN-R06 Multi-language targets:** a generator can project to multiple language bindings
  from one Layer 1 model — at minimum TypeScript, Rust, and Effect-idiomatic TypeScript —
  without a second source.
- **GEN-R07 Provenance:** every generated binding records its source path + an input
  fingerprint (content hash), so staleness is visible in normal repo checks.

### Composition and validation

- **GEN-R08 Composable source:** a generator's source composes across megarepo members via
  the non-emitted `meta` channel and a filesystem-free aggregator, never by
  reverse-engineering emitted files.
- **GEN-R09 Domain validation gate:** each generator provides a validation gate over its
  source/output (schema, policy, cross-reference integrity), wired into genie/devenv
  checks. An external tool (e.g. Weaver) may serve as an additive gate but MUST NOT be
  load-bearing for producing the bindings, and a build/availability failure of that tool
  MUST NOT wedge unrelated work (it degrades to a warning / separate lane, not a hard
  block).
