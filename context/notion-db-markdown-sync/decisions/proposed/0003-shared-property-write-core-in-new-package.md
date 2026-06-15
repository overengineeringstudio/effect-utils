# Shared property-write core lives in a new `@overeng/notion-property-write` package

Status: proposed

The shared `PropertyWriteProof` → allow/block guard evaluator, consumed by both
`notion-md` (`StandaloneLiveProofProvider`) and `notion-datasource-sync`
(`DatasourceWorkspaceProofProvider`), is placed in a new dedicated package
`@overeng/notion-property-write`. The package contains only pure core: proof
schema + guard evaluator, depending only on `notion-effect-schema`. IO-bearing
providers stay in their respective consumer packages.

This is required by R12 (entrypoint neutrality): neither CLI may own the shared
core. The `@overeng/notion-effect-schema` package is deliberately restricted to
values/codecs/descriptors/write-class with no authority, proof, or convergence
logic (Phase 1 boundary), so the core cannot live there.

Dependency chain evidence: `notion-datasource-sync` → `notion-md` →
`notion-effect-client` → `notion-effect-schema` → `notion-core`. Common ancestors
of both consumers are `notion-effect-client` and `notion-effect-schema`. The repo
strongly favors fine-grained `@overeng/*` packages.

## Considered Options

| Option                                                                                   | Result      | Reason                                                                                                                                     |
| ---------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| New `@overeng/notion-property-write` package (pure core: proof schema + guard evaluator) | Recommended | Entrypoint-neutrality is structural — neither CLI owns the core; cleanest dependency story; matches house style of small focused packages. |
| Put the pure core in `notion-effect-client`                                              | Rejected    | Mixes pure guard logic with an IO client; weaker boundary; tempts future coupling of proof logic to live client internals.                 |
| Put the pure core in `notion-effect-schema`                                              | Rejected    | Violates the Phase 1 schema boundary (no authority/proof/convergence).                                                                     |
| Duplicate per consumer                                                                   | Rejected    | Violates R09/R12 (shared semantics, entrypoint neutrality).                                                                                |

## Consequences

A new package requires genie/tsconfig/CI scaffolding. The long-term-ideal
boundary wins given the repo's small-package norm.

**Revisit trigger:** if the package turns out to be fewer than ~150 LOC of pure
types with no independent reuse, collapse into `notion-effect-client` at
ratification.
