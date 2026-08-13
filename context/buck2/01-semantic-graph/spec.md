# Semantic Graph Spec

This document specifies repository adapters and their portable graph output. It
builds on [requirements.md](./requirements.md).

## Status

Draft.

## Scope

**Defines:** graph ownership, adapter input/output, normalization, projection,
and freshness.

**Does not define:** dependency resolution algorithms or action command lines.

## Composition

```text
ecosystem metadata ---+
repository intent ----+--> repository adapter --> normalized graph
repository policy ----+                              |
                                                     v
                                           Buck projection/loader
```

The adapter composes facts but never becomes a resolver. A dependency handle
contains the resolver's opaque selected identity plus the declared closure
reference consumed by actions. Kernel schemas do not know whether the source
was TypeScript, Cargo, or another ecosystem.

## Kernel Graph Shape

```text
RepositoryGraph {
  schemaVersion
  packages: Package[]
  operations: Operation[]
  dependencyHandles: DependencyHandle[]
}

Package { id, root, firstPartyDeps, sourceRoles }
Operation { id, packageId, kind, sources, dependencyHandle, capabilities,
            outputs }
DependencyHandle { id, resolver, selectedIdentity, closureRef }
```

Concrete encodings are versioned. Unknown schema versions fail; additive fields
require a version or an explicitly tolerant reader. Paths are repository
relative, normalized, and must not escape their declared package root.

## Normalization and Projection

Normalization validates unique stable IDs, edge targets, source ownership,
operation output roles, and dependency-handle existence. Collections whose
order is not semantic are sorted before encoding.

A checked-in projection includes its schema version and digest of normalized
semantic input. Freshness verification regenerates into memory or temporary
storage, compares exact bytes, and reports the owning semantic source for a
mismatch. Projection generation performs no compilation, testing, dependency
installation, or tool discovery.

## Repository Adapter Conformance

Each adapter must prove:

1. equal input produces equal normalized bytes;
2. reordered non-semantic input produces equal bytes;
3. one local mutation changes only its owning shard and dependent operations;
4. missing, duplicated, or overlapping ownership fails;
5. resolver-selected identities survive round-trip unchanged;
6. public fixtures contain no consumer-private values.
