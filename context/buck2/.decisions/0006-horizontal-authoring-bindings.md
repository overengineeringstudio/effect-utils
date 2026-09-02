# 0006 Horizontal Authoring Bindings

Status: accepted

## Context

The semantic graph described a language-adapter boundary, but TypeScript
package-composition mechanics had entered the generic Genie projection and
language target-execution specs also owned authored ecosystem interpretation.
That mixed authoring, projection, and execution authorities.

## Evidence and Argument

The user-confirmed design review compared phase-oriented, language-oriented,
dependency-specific, and flat trees against the existing VRS, informed by four
independent delegated critiques. Repository source inspection found distinct
authored authorities for TypeScript package manifests,
tsconfig projects, test configuration, and operations, and for Rust Cargo
package, target, feature, and dependency facts. The normalized language
contribution is a coherent seam before Buck projection; resolver selection and
materialization remain downstream sibling inputs.

Horizontal separation makes invalidation and authority auditable: irrelevant
manifest metadata can stop at an authoring binding, projection receives only
normalized IR, and execution consumes closures and providers without reading
authored ecosystem configuration. The cost is that each language has separate
authoring and execution documentation.

## Options

| Option                                               | Result   | Tradeoff                                                                       |
| ---------------------------------------------------- | -------- | ------------------------------------------------------------------------------ |
| Horizontal authoring bindings                        | Selected | Strongest phase and authority separation; language documentation has two homes |
| Shared root seam plus vertical language integrations | Rejected | Lower navigation cost, but broader language nodes mix authoring and execution  |
| Keep the flat tree                                   | Rejected | Minimal move churn, but preserves category leaks and duplicate ownership       |

## Decision

Place a composable `01-authoring-bindings` subsystem under the semantic graph,
with TypeScript and Rust Cargo children. It translates existing authored
authorities plus explicit operation declarations into normalized language
contributions. Rename the following projection node to `02-buck-projection` and
keep it limited to normalized IR rendering and freshness. Target execution
remains a separate subsystem that consumes normalized targets, resolved
closures, platforms, and tools.

The Rust child ratifies the evidenced Cargo-manifest authority and repository
operation-overlay boundary while keeping advanced Cargo/Reindeer semantics
Draft until their experiments pass.

## Consequences

- Language bindings compose existing authorities; they do not introduce a new
  editable package or dependency map.
- TypeScript- and Rust-specific interpretation leaves the generic graph and
  projection contracts.
- Dependency materialization continues to own resolver selection, selected
  topology, and immutable bytes because operation roots are its inputs.
- A binding facet becomes a child subsystem only after it gains an independent
  versioned seam and admission lifecycle.
- Existing execution requirement identifiers remain stable unless their
  semantic ownership moves, while projection identifiers reflect their generic
  Buck projection ownership.
