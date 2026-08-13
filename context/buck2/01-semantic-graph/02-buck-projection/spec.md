# Buck Projection Specification

This document specifies the Buck semantic graph projection. It builds on
[requirements.md](./requirements.md).

## Status

Draft.

## Scope

This spec defines the pure projection interface, current Genie realization,
package-local shard shape, freshness flow, and projection verification. The
parent semantic graph owns all domain meaning. Buck realization owns rule
implementations and tools. The
[dependency-materialization Buck closure contract](../../../dependency-materialization/05-buck2-evidence/spec.md)
owns external dependency selection.

## Requirement Trace

| Section                  | Requirements                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------- |
| Projection boundary      | BUCK.GRAPH.PROJ-R01, BUCK.GRAPH.PROJ-R02, BUCK.GRAPH.PROJ-R03                      |
| Package-local shard      | BUCK.GRAPH.PROJ-R04, BUCK.GRAPH.PROJ-R05, BUCK.GRAPH.PROJ-R06, BUCK.GRAPH.PROJ-R07 |
| Freshness and provenance | BUCK.GRAPH.PROJ-R08, BUCK.GRAPH.PROJ-R09, BUCK.GRAPH.PROJ-R10                      |
| Verification             | BUCK.GRAPH.PROJ-R11                                                                |

## Projection Boundary

```text
Normalized Package IR
        |
        v
projectPackage(package, projectionSchema)
        |
        +--> package-local BUCK shard
        +--> non-semantic Genie freshness metadata
```

The adapter surface is pure:

```text
projectPackage(
  package: NormalizedPackage,
  schema: BuckProjectionSchema,
) -> GenieOutput<PackageProjection>
```

`projectPackage` may validate, normalize presentation order, and render text. It
has no process runner, compiler API, environment-derived tool path, network
access, compiler metafile input, or callback that can perform those operations.
The implementation is dependency-light and can be tested as a pure function.

The current realization uses Genie as a pure renderer and freshness engine.
Language-authoring bindings produce normalized graph values before this
boundary. A projection never imports an authored language projection to recover
semantic facts, parses rendered configuration, or registers semantic values in
global mutable state. Full Genie generation and freshness checking are
authoritative; watch mode is not evidence of transitive projection freshness.

## Package-Local Shard

Each shard loads one stable semantic facade and declares one package value:

```starlark
# GENERATED FILE - DO NOT EDIT
load("//buck2:semantic_package.bzl", "semantic_package")

semantic_package(
    name = "package",
    package_id = "@overeng/example",
    projects = [...],
    targets = [...],
    edges = [...],
)
```

The shard contains only normalized semantic data and the facade call. The
facade owns logical-label resolution and lowering to Buck rules. Registered
toolchains and providers own executable and platform selection.

File sets render as typed Buck-owned pattern expressions behind one `FileSet`
projection boundary. The independent census, rather than generated path lists,
proves complete and non-ambiguous ownership.

Stable logical IDs are rendered; physical locations are emitted only where the
facade needs a package-local path. Moving a package therefore changes its
location mapping, not its semantic identities or unrelated package shards.

## Freshness and Provenance

```text
discover authored Genie sources
  -> compose and normalize semantic package models
  -> render expected package-local shards
  -> compare expected bytes with committed outputs
  -> report exact owning source for every drift
```

Freshness rejects missing outputs, stale bytes, and conflicting ownership.
Generation reapplies read-only modes as a local editing guardrail, but check
mode does not treat ordinary write bits as identity because Git cannot preserve
them across checkout. Semantic bytes contain only data needed by Buck analysis.
Operational provenance that changes when the generator implementation changes
is retained in Genie's result metadata or a non-semantic sidecar, not in the
shard's semantic fingerprint.

Completeness is the separate stateless ownership assertion defined by the
parent semantic-graph spec. Genie projects the supported-file policy but does
not scan paths, evaluate Buck patterns, replace the projection, invoke build
tools, or feed discovered compiler inputs back into the model.

## Verification

The projection suite exercises the public projection boundary:

| Control                 | RED                                     | GREEN                                                     |
| ----------------------- | --------------------------------------- | --------------------------------------------------------- |
| Canonical ordering      | Reordering a set changes bytes          | Reordering a set is byte-identical                        |
| Renderer implementation | Equivalent renderer B changes bytes     | Equivalent renderers emit identical bytes                 |
| Unrelated package       | Package B edit rewrites package A shard | Package A remains byte-identical                          |
| Package move            | Logical IDs change implicitly           | Only location projection changes                          |
| Target split            | Existing meanings silently reuse IDs    | Preserved target stays stable; new target receives new ID |
| Tool change             | Tool identity appears in shard          | Shard is identical; Buck action dependency changes        |
| Purity                  | Projection can spawn a compiler         | Process/compile capability is absent or rejected          |

The authoritative Genie freshness command runs these validations through the
same projection entry point used to generate committed shards.
