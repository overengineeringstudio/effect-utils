# TypeScript Authoring Binding Specification

This document specifies the TypeScript Genie authoring binding. It builds on
[requirements.md](./requirements.md) and the shared
[authoring-binding specification](../spec.md).

## Status

Draft.

## Scope

This spec defines narrow package, TypeScript-project, and operation facets;
typed dependency handles; import direction; and normalization into the shared
language contribution. Genie projection renders the contribution, dependency
materialization resolves external roots, and TypeScript target execution binds
tools and actions.

## Requirement Trace

| Section                  | Requirements                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| Facet composition        | BUCK.GRAPH.BIND.TS-R01, BUCK.GRAPH.BIND.TS-R02, BUCK.GRAPH.BIND.TS-R03, BUCK.GRAPH.BIND.TS-R04 |
| Dependency handles       | BUCK.GRAPH.BIND.TS-R05, BUCK.GRAPH.BIND.TS-R06, BUCK.GRAPH.BIND.TS-R07                         |
| Normalization and parity | BUCK.GRAPH.BIND.TS-R08, BUCK.GRAPH.BIND.TS-R09, BUCK.GRAPH.BIND.TS-R10                         |
| Admission                | BUCK.GRAPH.BIND.TS-R11                                                                         |

## Facet Composition

```text
catalog + pure builders
       |
       +--> package.json.genie.ts ----> PackageFacet + package.json projection
       |
       +--> tsconfig*.genie.ts -------> ProjectFacet + tsconfig projection
       |
       `--> BUCK.genie.ts ------------> OperationFacet
                    ^                         |
                    +-- PackageFacet --------+
                    +-- ProjectFacet --------+
```

The facets are immutable structural values carried in the existing non-emitted
`GenieOutput.meta` channel. The default Genie values continue to render the
current package and project files. An operation module imports only narrow
facets, not `GenieOutput.data`, rendered JSON, or another projection's bytes.

```typescript
interface PackageFacet<PackageId extends string, Declarations> {
  readonly kind: 'typescript-package-facet/v1'
  readonly packageId: PackageId
  readonly dependencies: Declarations
}

interface ProjectFacet<ProjectId extends string> {
  readonly kind: 'typescript-project-facet/v1'
  readonly projectId: ProjectId
  readonly tsconfig: RepoRelativePath
  readonly projectReferences: readonly LogicalTargetId[]
  readonly fileSets: readonly FileSetIntent[]
}

interface OperationFacet<Uses> {
  readonly kind: 'typescript-operation-facet/v1'
  readonly id: LogicalTargetId
  readonly project: LogicalTargetId
  readonly operationKind: TypeScriptOperationKind
  readonly uses: readonly Uses[]
}
```

The type parameters exist only while authoring. The normalized contribution
does not retain package-specific generic unions.

Import direction is strict:

```text
pure helpers -> package/project facets -> operation facet -> graph projection
```

Package and project generators never import `BUCK.genie.ts`, a renderer, or a
target-execution module. Facets register nothing at import time. Re-evaluating
any generator creates equal values without requiring module singleton state.

## Dependency Handles

Composition creates handles before manifest dependency maps widen:

```typescript
type DependencyHandle<
  PackageId extends string,
  Field extends RootableDependencyField,
  Alias extends string,
> = Readonly<{
  kind: 'typescript-dependency-handle/v1'
  package: PackageId
  field: Field
  alias: Alias
  source: 'external' | 'workspace'
  workspacePackage?: LogicalPackageId
  readonly __brand: unique symbol
}>
```

The brand is compile-time authoring safety only. Runtime identity is the
structural tuple. `workspacePackage` is present only for a workspace request
and carries a public logical package identity, never its physical path or
private topology.

An operation references the exact declarations it observes:

```typescript
const packageModel = catalog.compose({
  dependencies: { external: catalog.pick('effect') },
  devDependencies: { external: catalog.pick('typescript', 'vitest') },
})

export const operations = {
  check: ts.check({
    project: tsconfigFacet,
    uses: [packageModel.meta.dependencies.devDependencies.typescript],
  }),
  test: ts.test({
    project: tsconfigFacet,
    uses: [
      packageModel.meta.dependencies.dependencies.effect,
      packageModel.meta.dependencies.devDependencies.vitest,
    ],
  }),
}
```

Rootable fields are `dependencies`, `devDependencies`, and
`optionalDependencies` only where the operation kind defines their legality.
`peerDependencies` and inherited peer declarations expose no handles. Shared
named use sets may be authoring syntax, but they expand to explicit handles
before normalization and do not create another dependency authority.

## Normalization and Parity

`normalizeTypeScriptPackage` performs a pure join:

```typescript
function normalizeTypeScriptPackage(
  packageFacet: PackageFacet<string, unknown>,
  projects: readonly ProjectFacet<string>[],
  operations: readonly OperationFacet<unknown>[],
): LanguageContributionV1
```

For each operation, normalization resolves every structural handle against the
owning package facet, validates operation-field legality, maps workspace
declarations to first-party edges, maps external declarations to
`DependencyRootRef { package, binding: "typescript-package/v1", selector: {
field, alias } }`, sorts and deduplicates the results, and erases all handle
generics. Foreign package IDs, absent aliases, peer fields, provenance
mismatches, and conflicting project IDs are hard failures.

Package JSON and tsconfig generation consume their unchanged default data.
Operation-only edits therefore leave both projections byte-identical. Package
metadata not consumed by a facet leaves graph contribution and BUCK projection
bytes identical. A dependency declaration or project semantic change affects
only its owning package and declared consumers.

## Admission

The retained TypeScript fixture runs through real Genie discovery, generation,
freshness, and graph normalization:

| Control           | Required evidence                                                      |
| ----------------- | ---------------------------------------------------------------------- |
| Literal keys      | Unknown alias fails TypeScript checking and runtime normalization      |
| Field collision   | Same alias in two fields remains distinguishable                       |
| Projection parity | Existing package and tsconfig bytes remain byte-identical              |
| Import DAG        | Any reverse operation-to-authority import is rejected                  |
| Re-evaluation     | Reordered and repeated discovery emits identical values and bytes      |
| Privacy           | Paths, selected versions, and private topology cannot enter handles    |
| Locality          | Operation-only and unrelated metadata mutations have bounded fanout    |
| Scale             | Normalized declarations stay bounded when dependency cardinality grows |

The current prototypes establish the facet direction and generic-erasure
need. Production authority begins only when these controls are retained and
run by the repository's supported Genie check.
