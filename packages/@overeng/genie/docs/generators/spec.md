# Generators — Specification

This document specifies the shared genie **generator** mechanism. It builds on
[requirements.md](./requirements.md). Each generator child refines this for its domain.

## Status

Draft. The mechanism is validated by the semantic-conventions generator prototype (see
[01-semantic-conventions/](./01-semantic-conventions/spec.md)).

## Scope

Defines: the two-layer architecture (foundation + composition), the multi-target
projection model, the provenance/freshness contract, and the composition + validation
boundary shared by all generators.

Does not define: any single generator's domain model (owned by that child), nor genie's
core engine (owned by genie's root spec).

## The two layers (GEN-R01, GEN-R02)

```
 authored via Layer 2 (opinionated)          OR authored directly at Layer 1
 ┌───────────────────────────────┐
 │ Effect-Schema values +         │
 │ composition; single source     │──── projects ────┐
 │ derives MULTIPLE artifacts      │                  │
 └───────────────────────────────┘                  ▼
                                          ┌──────────────────────┐
                                          │ LAYER 1 (foundation)  │  faithful, typed,
                                          │ resolved domain model │  1:1 with the target
                                          └───────────┬──────────┘  vocabulary; standalone
   Layer 2 may ALSO derive, from the same             │ deterministic projection
   authored value, sibling artifacts        ┌─────────┼──────────┬──────────────┐
   (e.g. a runtime contract) — see child     ▼         ▼          ▼              ▼
                                          output   TS bindings  Rust bindings  Effect-Schema
                                          (e.g.    (constants)  (structs)      contracts
                                          YAML)                                (idiomatic)
                                             │
                                       domain validation gate (+ optional additive external tool)
                                             │
                                       read-only, drift-gated, fingerprinted (GEN-R05/R07)
```

**Layer 1 (foundation, GEN-R01)** is a direct, faithful, dependency-light model of the
target domain's own vocabulary — the mechanism of record. It projects deterministically to
the output and to language bindings, and is usable STANDALONE (full control; decoupled or
hand-tuned cases).

**Layer 2 (composition, GEN-R02)** is an opt-in opinionated layer for ergonomic authoring
and single-source multi-artifact derivation. Its idiom is generator-specific — composition/
aggregation helpers (as in package.json/tsconfig), higher-order combinators (github-
workflow), or an Effect-Schema authoring surface (the semantic-conventions generator, whose
attributes are annotated Schemas that derive both the registry and the runtime encoder).
Effect Schema is thus one Layer-2 flavor, not the definition. Layer 2 always projects DOWN
to Layer 1; it never emits by bypassing the foundation. Whether Layer-2 authoring is the
default or an opt-in per artifact is a generator-level decision.

Whatever layer is used, a given artifact has ONE authored source and the rest derive
(GEN-R03); the chain source → Layer 1 model → binding is explicit and documented per
generator (GEN-R04).

## Multi-target projection (GEN-R06)

A generator declares targets; each target is a pure function `layer1Model → fileContent`.
Minimum target set:

| Target               | Shape                                                                   | Notes                                                               |
| -------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------- |
| TypeScript constants | `export const X = "..." as const` + name unions                         | plain literals                                                      |
| Effect-idiomatic TS  | `Schema`-based contracts, branded names, tagged errors, typed accessors | the primary runtime surface; composes with `@overeng/otel-contract` |
| Rust                 | `const`/`struct` bindings                                               | for Rust consumers (e.g. otel-scrape)                               |

An external tool's codegen (e.g. Weaver's Jinja) may back the Rust/other targets, but per
GEN-R09 it is an additive path — genie can project any target directly from the Layer 1
model, so binding production never depends on the external tool being present.

## Provenance & freshness (GEN-R07)

Each emitted binding carries a header: `source: <path>` + `fingerprint: sha256:<hash of
source>`. Combined with genie's read-only chmod + freshness gate, a stale binding fails
locally and in CI. (Pattern reused from the otel-scrape registry generator.)

## Composition (GEN-R08)

Member fragments are contributed on the `meta` channel; a filesystem-free root aggregator
composes them into one Layer 1 model (dedup + deterministic sort), mirroring
`aggregateFromPackages` / `tsconfigReferencesFromPackages`. Never reverse-engineer
contributions from emitted files.

## Validation boundary (GEN-R09)

Each generator supplies a validation gate over source/output (schema, policy, reference
integrity), wired into genie/devenv checks. An external tool (e.g. OTel Weaver for the
semantic-conventions generator) may run as an ADDITIVE gate — it can fail a build but is
never required to produce the bindings. A build/availability failure of that tool must
degrade to a warning or a separate lane, never wedge unrelated work (GEN-R09).

## Design Questions

- **GEN-DQ1 Shared vs per-generator layer libraries:** should the Layer 1 model
  primitives and the TS/Rust/Effect target renderers be a shared, generator-agnostic
  library (each generator supplies only its domain vocabulary + target map), or owned per
  generator? Leaning shared, to make GEN-R06 cheap for the second and third generators.
  Resolves once a second generator exists. Risk: the shared contract ossifying around
  semconv's shape before generator #2 exists.
- **GEN-DQ2 Layer 2 shape — largely settled by the first generator:** the semantic-
  conventions generator validated a concrete Layer 2 — attributes are annotated Effect
  Schemas built on `@overeng/otel-contract` primitives; one AST reader projects Layer 1,
  and otel-contract's own AST reader derives the runtime encoder (see
  [01-semantic-conventions/spec.md](./01-semantic-conventions/spec.md)). Open: how much of
  this Layer-2 machinery (the annotation convention, the AST→Layer1 projector) generalizes
  vs stays semconv-specific. Resolves once generator #2 needs a Layer 2.
