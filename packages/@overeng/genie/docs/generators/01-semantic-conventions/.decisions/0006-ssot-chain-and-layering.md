# 0006 — SSOT chain, layering, and Layer-2 home

**Status:** Accepted.

## Context

The design needs a clean, composable, hierarchical architecture with a single explicit
source-of-truth chain and minimal non-derived redundancy — and a home for each layer given
genie's dependency-free-runtime constraint and that Layer 2 is a *runtime* authoring surface
(not codegen).

## Decision

### Single source of truth

The atom is an **attribute authored once as an annotated Effect Schema** carrying both otel
runtime metadata (`key`/`cardinality`/`encode`) and weaver design-time metadata
(`brief`/`stability`/`examples`/`type`). Signals compose attribute *refs* + a per-ref
requirement level. These — attributes and signals — are the ONLY hand-authored facts.
Everything else derives:

```
attribute (annotated Schema) ─┬─► runtime encoder      (OtelAttrs.define; product APIs)   [runtime]
                              ├─► registry fragment    (annotations → plain data)         [design-time]
signal (refs + requirement) ─┘        ├─► Weaver groups: YAML → check/diff/live-check
                                      ├─► TS name constants
                                      ├─► Rust bindings
                                      └─► bridge OTTL (from a `bridge:` annotation, 0004)
```

**Invariant — minimal non-derived redundancy:** every fact (key, cardinality, requirement
level, namespace) is authored in exactly one place; the same key appearing in encoder + YAML
+ constants + Rust is derivation, not duplication. Same-concept-same-key across span/metric
(0003) and ref-don't-redefine for upstream/cross-member attrs are corollaries.

- **Namespace is derived**, not authored: `defineOtelContract` derives it from the common
  key prefix and validates every key shares it (a stray key is a hard error).
- **Catalog is derived**, not listed: the `registry.<ns>` attribute set is the union of the
  attributes signals reference plus any explicit *doc-only* attributes; you author signals,
  the catalog falls out.

### Layering (each depends only downward)

| Layer | Home | Role | Deps | Imported by |
| --- | --- | --- | --- | --- |
| **L2** | `@overeng/otel-contract` `.` | runtime authoring SSOT: `attr`/`span`/`metric` (annotated Schemas), encoders, product APIs | `effect` | product code (runtime) |
| **L2-proj** | `@overeng/otel-contract` `./registry` | design-time: annotations → plain registry fragment | `effect` | `.genie.ts` only |
| **L1** | `@overeng/genie` `src/runtime/weaver` | dep-free: registry fragment → YAML / TS / Rust | none heavy | `.genie.ts` |
| compose | `weaver.genie.ts` (per pkg) + `registry.genie.ts` (root) | project (L2) + render (L1) | — | genie engine |

Layer 2 is `@overeng/otel-contract` evolved (the runtime authoring surface it already owns,
gaining weaver annotations) — NOT a new package and NOT codegen. The one design-time piece
(the projector) sits behind a `./registry` subpath, mirroring genie's `/composition`
subpath, so it never reaches a runtime bundle. Layer 1 is a dep-free genie runtime builder,
like `package-json`/`tsconfig`.

### Composition hierarchy (mirrors `rootWorkspacePackages`)

Each package's registered seam (`defineOtelContract`, 0005) contributes a fragment on the
non-emitted `meta` channel; a root `registry.genie.ts` imports every seam and composes one
registry (ref-integrity + namespace-uniqueness enforced at aggregation), which genie L1
renders and the weaver gate validates.

## Consequences

- One authoring surface (annotated Schemas + signals); everything else derived → no drift by
  construction.
- Runtime consumers import only `otel-contract` `.`; codegen never enters a product bundle.
- Residual runtime cost: the weaver annotations (inert `brief`/`stability`/`examples`
  strings) ride on the Schemas; strippable in the runtime build if ever material.

## Alternatives rejected

- **New `@overeng/otel-registry` package (earlier lean):** rejected — Layer 2 is runtime, so
  a separate package would fragment the runtime authoring API or hold only the tiny
  projector. The `./registry` subpath isolates the one design-time piece without a package.
- **Explicit namespace / listed catalog:** redundant with the keys / the signal refs.
