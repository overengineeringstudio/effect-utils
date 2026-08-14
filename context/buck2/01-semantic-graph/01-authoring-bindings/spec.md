# Authoring Bindings Specification

This document specifies the shared language-authoring adapter boundary. It
builds on [requirements.md](./requirements.md).

## Status

Draft.

## Scope

This spec defines authority composition, provenance retention, contribution
normalization, and admission rules shared by language bindings. Child specs
own ecosystem interpretation. The parent semantic graph owns normalized graph
meaning; Buck projection owns generated syntax; dependency
materialization owns resolver state; target execution owns actions and tools.

## Requirement Trace

| Section                    | Requirements                                                  |
| -------------------------- | ------------------------------------------------------------- |
| Authority composition      | BUCK.GRAPH.BIND-R01, BUCK.GRAPH.BIND-R02, BUCK.GRAPH.BIND-R03 |
| Shared contribution        | BUCK.GRAPH.BIND-R04, BUCK.GRAPH.BIND-R05, BUCK.GRAPH.BIND-R06 |
| Normalization and locality | BUCK.GRAPH.BIND-R07, BUCK.GRAPH.BIND-R08                      |
| Admission                  | BUCK.GRAPH.BIND-R09                                           |

## Authority Composition

```text
language-native authorities ----+
                                 +--> language binding --> LanguageContributionV1
repository semantic overlay ----+             |
                                               `--> authority/provenance validation
```

The native authority and overlay are separate inputs. A binding joins them by
stable logical identity; the overlay never shadows or copies native fields.

| Fact class                             | Owner                                      |
| -------------------------------------- | ------------------------------------------ |
| Package and project ecosystem facts    | Language-native authority                  |
| Direct dependency requests             | Language-native package authority          |
| Operation intent absent from ecosystem | Repository-owned semantic overlay          |
| Selected dependency topology and bytes | Dependency-materialization contract        |
| Normalized graph entities              | Parent semantic graph                      |
| BUCK syntax and action implementation  | Projection and target-execution subsystems |

Bindings use ecosystem-specific typed facets internally. There is no shared
manifest schema and no requirement that two languages expose the same
authoring API. The common surface begins only at the closed contribution.

## Shared Contribution

```text
LanguageContributionV1 {
  binding: BindingId
  bindingSchemaVersion: 1
  package: PackageContribution
  projects: ProjectContribution[]
  operations: OperationContribution[]
}

OperationContribution {
  id: LogicalTargetId
  project: LogicalTargetId
  kind: LanguageOperationKind
  dependencyRoots: DependencyRootRef[]
  languageData: StrictVersionedValue
}
```

`PackageContribution`, `ProjectContribution`, `OperationContribution`, and
`DependencyRootRef` are parent graph concepts. The binding may construct
richer typed values while authoring, but it erases language-specific generic
types at this boundary. `languageData` contains only semantics that cannot be
represented by a shared field; it cannot carry executable paths, callbacks,
resolver output, or arbitrary native-manifest fragments.

Dependency-root normalization proceeds in this order:

1. Resolve each authored use against a canonical direct declaration in the
   same package authority.
2. Reject unknown, foreign-package, duplicated, or illegal-scope uses.
3. Project workspace requests into logical first-party edges.
4. Project external requests into a binding-qualified, strictly versioned
   canonical declaration selector.
5. Sort and deduplicate roots and erase binding-specific handle types.

Requested constraints remain available to dependency materialization through
their native authority. They do not enter the operation contribution merely
because an operation references the declaration.

## Normalization and Locality

```text
facet values --validate--> binding-local typed model --erase--> contribution
     |                                                           |
     `-- no process, path, registry, or object identity ----------+
```

A binding is a deterministic data transformation. Its result cannot depend on
module singleton behavior, import-time registration, mutable global state,
symbol identity, the process environment, filesystem discovery, or tool
execution. Stable logical values survive repeated evaluation.

Facet dependencies form a directed acyclic graph. A semantic overlay may
consume native-authority facets, while a native authority must never import a
projection or an overlay that consumes it. Renderers consume the closed
contribution and do not become part of authority composition.

Tests compare normalized contributions and rendered bytes across reordered
set-like inputs, repeated evaluation, equivalent adapter implementations, and
irrelevant facet mutations. A relevant change must alter only its owning
package contribution and declared consumers.

## Admission

Each binding maintains executable controls at its real authoring-to-graph seam:

| Control                 | RED                                                   | GREEN                                                   |
| ----------------------- | ----------------------------------------------------- | ------------------------------------------------------- |
| Single authority        | Overlay repeats a native declaration                  | Overlay references its canonical identity               |
| Reference validity      | Unknown, foreign, or illegal-scope reference accepted | Composition fails before projection                     |
| Provenance              | Widened maps merge distinct declarations              | Typed composition preserves source and field            |
| Determinism             | Evaluation order or repetition changes bytes          | Normalized contribution is byte-identical               |
| Privacy                 | Private path or selected topology reaches projection  | Only stable logical references cross the boundary       |
| Locality                | Irrelevant facet edit changes an operation            | Unconsumed fields and unrelated packages stay identical |
| Unsupported native fact | Binding silently approximates its meaning             | Binding fails with the exact unsupported semantic fact  |

The child binding identifies its native oracle and its unsupported-feature
matrix. A self-check without a deliberate RED case is not admission evidence.

## Child Bindings

- [01-typescript](./01-typescript/spec.md) defines the Genie package,
  TypeScript project, and operation facets.
- [02-rust-cargo](./02-rust-cargo/spec.md) defines the bounded Cargo manifest
  and repository-overlay boundary.
