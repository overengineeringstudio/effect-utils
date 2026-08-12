# Semantic Graph Specification

This document specifies the Buck semantic graph. It builds on
[requirements.md](./requirements.md).

## Status

Draft.

## Scope

This spec defines the composed package model, normalized runtime-neutral IR,
identity and edge rules, language-adapter boundary, and field ownership. It does
not define Genie execution, generated BUCK syntax, dependency package bytes,
toolchain selection, or action commands. Those belong to the child subsystem
specs, the parent Buck spec, and the dependency-materialization VRS.

## Requirement Trace

| Section                       | Requirements                                                   |
| ----------------------------- | -------------------------------------------------------------- |
| Composition and ownership     | BUCK.GRAPH-R01, BUCK.GRAPH-R04                                 |
| Runtime-neutral IR            | BUCK.GRAPH-R02, BUCK.GRAPH-R03, BUCK.GRAPH-R05, BUCK.GRAPH-R06 |
| Normalization and evolution   | BUCK.GRAPH-R07, BUCK.GRAPH-R08                                 |
| Adapter boundary              | BUCK.GRAPH-R09, BUCK.GRAPH-R10, BUCK.GRAPH-R11                 |
| Completeness and invalidation | BUCK.GRAPH-R12, BUCK.GRAPH-R13, BUCK.GRAPH-R14, BUCK.GRAPH-R15 |

## Composition and Ownership

```text
package authority ----+
project authority ----+---> composed package model ---> normalized graph IR
test authority -------+              |                         |
artifact intent ------+              |                         +--> projections
                                      +--> ownership audit      +--> realizations
```

The composed package model is the single graph-authoring boundary. Each domain
authority contributes facts; composition validates joins and emits one package
value. Composition never discovers compiler behavior or treats an emitted file
as authoritative input.

| Fact                                                              | Semantic authority                  | Not authoritative                 |
| ----------------------------------------------------------------- | ----------------------------------- | --------------------------------- |
| Package logical name and declared package dependencies            | Package/workspace model             | BUCK labels or generated shards   |
| Project language, config, and source partitions                   | Language-project model              | Toolchain or compiler output      |
| Test suite name, framework contract, config, and source partition | Test model                          | Test-runner discovery output      |
| Artifact entry, output format, and required validations           | Package-local artifact declaration  | Packer or compiler implementation |
| Logical-to-physical location                                      | Repository graph resolver           | Logical identity                  |
| Tool, platform, execution policy, and provider binding            | Buck realization                    | Semantic graph                    |
| External package content and materialization identity             | Dependency-materialization contract | Semantic graph projection         |

## Runtime-Neutral IR

The following structural schema is normative. Concrete bindings may use richer
types, but serialized values preserve these tags and meanings.

```text
SemanticGraphV1 {
  schemaVersion: 1
  packages: Package[]                         # sorted by package.id
}

Package {
  id: LogicalPackageId
  location: RepoRelativePath
  visibility: "public" | "private"
  projects: Project[]                         # sorted by project.id
  targets: Target[]                           # sorted by target.id
}

Project {
  id: LogicalTargetId
  language: LanguageId
  config: RepoRelativePath
  fileSets: FileSetRef[]
  adapterData: StrictVersionedValue
  capabilities: CapabilityRequirement[]
}

Target =
  | { tag: "check", id, project, checkKind, fileSets, capabilities }
  | { tag: "test", id, project, suiteKind, config, fileSets, capabilities }
  | { tag: "artifact", id, project, artifactKind, entry, outputFormat,
      validations, fileSets, capabilities }

Edge {
  from: LogicalTargetId
  to: LogicalPackageId | LogicalTargetId
  kind: "compile" | "runtime" | "test" | "validation" | "artifact"
}

CapabilityRequirement {
  id: CapabilityId
  constraints: StrictVersionedValue
}
```

`adapterData` contains only language semantics that cannot be expressed by the
shared entities. It cannot contain executable paths, action arguments, detected
host properties, or opaque callbacks. A schema registry validates it by
`language` and schema version.

Logical IDs are repository-stable names. `location` is resolver input and may
change independently. A target split preserves any target whose semantics stay
the same and assigns new IDs to newly distinct targets; it does not reuse one ID
for multiple meanings.

## Normalization and Evolution

Normalization performs these steps in order:

1. Strictly decode every authority contribution.
2. Join contributions by logical package and project ID.
3. Reject duplicate IDs, missing references, invalid edge kinds, and ownership
   conflicts.
4. Canonicalize set-like fields and preserve explicitly ordered fields.
5. Run file-ownership and adapter validation.
6. Emit `SemanticGraphV1` or a structured failure; partial graph output is not
   consumable.

An incompatible semantic change introduces a new top-level schema version.
Renderer, generator, or tool implementation versions are not graph fields.

## Adapter Boundary

```text
LanguageAdapter {
  languageId
  adapterSchemaVersion
  decodeProject(authorityData) -> ProjectContribution | AdapterError
  validateProject(project, packageGraph) -> ValidationError[]
}
```

An adapter owns language syntax and ecosystem interpretation. For example, a
TypeScript adapter may interpret project references and a Rust adapter may
interpret Cargo targets. Both emit the same project, target, edge, file-set,
artifact, and capability concepts. Neither selects `tsgo`, Bun, `rustc`, Cargo,
Nix paths, or an execution platform.

Cross-language edges refer only to logical IDs and shared edge kinds. Adapter
data from one language is never an input to another adapter.

## Completeness and Invalidation

The graph verifier exercises the following matrix:

| Change                            | Semantic projection                    | Required downstream effect                            |
| --------------------------------- | -------------------------------------- | ----------------------------------------------------- |
| File added inside an owned set    | Governed by DQ1                        | Owning target input/action changes                    |
| Supported file outside every set  | No accepted graph                      | Completeness check fails                              |
| Unrelated package edit            | Unrelated shard remains byte-identical | No unrelated action invalidation                      |
| Equivalent normalizer or renderer | All semantic bytes remain identical    | No semantic invalidation                              |
| Target split                      | Owning package projection changes      | Only new/changed targets receive new identities       |
| Physical package move             | Logical model identity remains stable  | Location resolver changes                             |
| Tool implementation change        | Semantic projection remains identical  | Affected action key changes through Buck dependencies |

Each control has a RED form that violates the invariant and a GREEN form through
the real graph/projection/analysis seam.

## Child Subsystems

- [01-genie-projection](./01-genie-projection/spec.md) specifies pure Genie
  projection and freshness.
- [Dependency-materialization Buck closures](../../dependency-materialization/05-buck2-evidence/spec.md)
  own the target-specific join to external resolver and materialization facts.

## Design Questions

### BUCK.GRAPH-DQ1 File-set representation (interview q13)

Which representation should connect declared semantic file ownership to Buck?

| Option                          | Shape                                                              | Locality                                                                                 | Completeness                                    | Cost                                                         |
| ------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------ |
| `owned-file-sets` (recommended) | Typed Buck-owned file sets plus an independent completeness census | Matching additions leave generated shard bytes stable and invalidate only owning actions | Exact, when the independent census is mandatory | Requires a file-set type and separate census gate            |
| `enumerated-shards`             | Genie enumerates every matched path into each generated shard      | Every matching add rewrites the owning shard                                             | Exact within generator discovery                | Large generated diffs and generator-coupled source discovery |
| `broad-package-glob`            | One coarse package glob feeds all package targets                  | Simple but broad target invalidation                                                     | Cannot by itself prove target ownership         | Lowest authoring cost, weakest incremental behavior          |

This remains unresolved. Resolution requires causal RED/GREEN evidence for a
matching source addition, unmatched supported source, unrelated package edit,
target split, and measured Buck action-key fanout. The recommendation is not a
decision until those controls are accepted.
