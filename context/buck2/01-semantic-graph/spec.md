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

| Section                        | Requirements                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------ |
| Composition and ownership      | BUCK.GRAPH-R01, BUCK.GRAPH-R04                                                 |
| Runtime-neutral IR             | BUCK.GRAPH-R02, BUCK.GRAPH-R03, BUCK.GRAPH-R05, BUCK.GRAPH-R06                 |
| Normalization and evolution    | BUCK.GRAPH-R07, BUCK.GRAPH-R08                                                 |
| Adapter boundary               | BUCK.GRAPH-R09, BUCK.GRAPH-R10, BUCK.GRAPH-R11                                 |
| Completeness and invalidation  | BUCK.GRAPH-R12, BUCK.GRAPH-R13, BUCK.GRAPH-R14, BUCK.GRAPH-R15, BUCK.GRAPH-R16 |
| Generated projection lifecycle | BUCK.GRAPH-R17                                                                 |

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
  | { tag: "check", id, project, checkKind, fileSets, dependencyRoots,
      capabilities }
  | { tag: "test", id, project, suiteKind, config, fileSets,
      dependencyRoots, capabilities }
  | { tag: "artifact", id, project, artifactKind, entry, outputFormat,
      validations, fileSets, dependencyRoots, capabilities }

DependencyRootRef {
  package: LogicalPackageId
  binding: BindingId
  selector: StrictVersionedValue
}

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

`dependencyRoots` are sorted, duplicate-free references to canonical package
dependency declarations. `binding` selects the strict versioned selector
schema; it is not an implementation-language tag. Language bindings validate
declaration, scope, and context legality, project workspace requests into
first-party edges, and pass external roots to the dependency-materialization
contract. Selectors never embed requested or selected versions, resolver
contexts, transitive edges, or physical paths.

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
AuthoringBinding {
  bindingId
  bindingSchemaVersion
  compose(nativeAuthorities, semanticOverlay)
    -> LanguageContribution | BindingError
}

LanguageContribution {
  package: PackageContribution
  projects: ProjectContribution[]
  operations: OperationContribution[]
}
```

An authoring binding owns language syntax and ecosystem interpretation. For
example, the TypeScript binding may interpret project references and the Rust
binding may interpret Cargo targets. Both emit the same package, project,
target, edge, file-set, artifact, dependency-root, and capability concepts.
Neither selects `tsgo`, Bun, `rustc`, Cargo, Nix paths, or an execution
platform. The child authoring-binding contract refines this single interface;
there is no separate project-only adapter seam.

Cross-language edges refer only to logical IDs and shared edge kinds. Adapter
data from one language is never an input to another adapter.

## Completeness and Invalidation

The graph verifier exercises the following matrix:

| Change                            | Semantic projection                    | Required downstream effect                      |
| --------------------------------- | -------------------------------------- | ----------------------------------------------- |
| File added inside an owned set    | Generated shard remains byte-identical | Only consumers of the owned set change          |
| Supported file outside every set  | No accepted graph                      | Completeness check fails                        |
| Unrelated package edit            | Unrelated shard remains byte-identical | No unrelated action invalidation                |
| Equivalent normalizer or renderer | All semantic bytes remain identical    | No semantic invalidation                        |
| Target split                      | Owning package projection changes      | Only new/changed targets receive new identities |
| Physical package move             | Logical model identity remains stable  | Location resolver changes                       |
| Tool implementation change        | Semantic projection remains identical  | Action key changes through Buck dependencies    |

Each control has a RED form that violates the invariant and a GREEN form through
the real graph/projection/analysis seam.

## Generated Projection Lifecycle

Committed Buck parser inputs and cross-boundary descriptors are deterministic
projections, never graph authorities. Their provenance binds the generator
contract ID and projection schema into the semantic fingerprint, names the
exact authored source and semantic inputs, and records the canonical
regeneration command. Output-specific emitter sources stay separate so a
change to one projection does not churn an unrelated sibling projection.

Genie derives freshness membership from the structural `*.genie.ts -> output`
pair and retains marker discovery only for compatibility. CI runs the complete
freshness check unconditionally; path filters remain local performance hints.
Review keeps compact `BUCK` contracts and the selected root Cargo lock visible,
while large generated dependency plans and mechanical script projections may
be collapsed.

Historical benchmark captures are immutable evidence, not current generated
state. Their checker pins content digests and includes a mutation control; it
must never replace the capture by regenerating “latest” results. Nix store
outputs, exported archives, descriptors, staged manifests, and receipts remain
ephemeral derivation outputs. Golden fixtures stay handwritten when generating
them from their producer would make the proof circular.

## Child Subsystems

- [01-authoring-bindings](./01-authoring-bindings/spec.md) specifies how
  ecosystem authorities and package-local operation declarations compose into
  normalized graph contributions.
- [02-buck-projection](./02-buck-projection/spec.md) specifies pure Buck
  projection and freshness through the current Genie realization.
- [Dependency-materialization Buck closures](../../dependency-materialization/05-buck2-evidence/spec.md)
  own the target-specific join to external resolver and materialization facts.

## Owned File Sets

Semantic targets declare typed, role-specific file-set patterns. Genie
validates their syntax, role compatibility, explicit sharing rules, and stable
rendering, then emits package-local Buck file-set expressions without listing
every matched path.

```text
typed semantic file-set declarations
              |
              +--> stable generated Buck expressions
              |            |
              |            `--> Buck observes matching membership
              |
              `--> independent repository census
                             |
                             `--> missing or ambiguous ownership fails
```

A matching add, delete, or rename changes Buck's file-set membership and only
the consuming action closures; it does not rewrite generated BUCK bytes. A
pattern or semantic-role change rewrites only the owning package shard. Broad
package-wide globs are invalid when roles have different consumers. An exact
enumerated set is permitted only for a target with a distinct invariant that
cannot be expressed safely as a typed pattern; it is not the repository
default.

Admission requires causal RED/GREEN controls for matching additions, unmatched
supported files, ambiguous overlaps, unrelated package edits, target splits,
and measured action-key fanout.

## Stateless Ownership Assertion

Completeness is one stateless admission command, not another build subsystem:

```text
Git tracked + nonignored untracked paths
                   |
                   +--> deterministic cardinality join --> pass/fail JSON
                   |
Buck uquery owner(files) results
```

The command enumerates the repository path universe with Git, filters it by the
supported-file policy projected from the semantic model, and submits the
candidate paths to one batched Buck ownership query. Buck remains the sole
evaluator of package boundaries and file-set patterns. The assertion only
classifies each governed path as missing, exactly-one primary owner, or
ambiguous. Multiple consumers may reference the same primary owned set.

Its normalized output is `buck-owned-files/v1` with sorted counts, missing
paths, and ambiguous paths plus owner IDs. It contains no file contents or
hashes. The command has no daemon, database, cache, committed membership
snapshot, custom matcher, graph compiler, or repository-wide Buck action. It
runs on demand and in the existing Buck CI lane; it does not become Genie
freshness or an input to ordinary build actions.

The minimum proof corpus establishes that an unmatched supported addition fails,
placing that file under an existing owned pattern passes without changing
generated BUCK bytes, overlapping primary sets fail, and an unsupported
unrelated file has no effect.
