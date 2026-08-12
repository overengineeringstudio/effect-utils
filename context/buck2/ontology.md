# Buck2 Repository Build Ontology

## Language

**Semantic Package Model** is the implementation-neutral, typed source of
first-party package identity, projects, tests, artifacts, dependency requests,
and required capabilities. It contains no executable or physical tool path.

**Semantic Operation** is a versioned logical unit such as a project check,
test suite, library build, or standalone artifact. Its identity and output
contract remain stable across executor implementations.

**Semantic Graph** is the normalized packages, operations, first-party edges,
file-set roles, artifact relations, and capability requirements from which Buck
topology is projected.

**Projection** is a deterministic, checked-in representation derived from the
Semantic Graph. A projection is not an independent authoring authority.

**Resolver Projection** is the selected external dependency topology emitted by
an ecosystem resolver or its faithful adapter. First-party graph generators may
reference it but may not recreate its selections.

**Execution Platform** is the environment in which an action runs. **Target
Platform** is the environment for which the result is produced. Equality of one
does not imply equality of the other.

**Stage-0 Tool** is an immutable externally produced executable used to break a
self-hosting cycle. Its producer, bytes, protocol, and platform are declared;
it is not an ambient fallback.

**Authority Slice** is the smallest semantic operation and admitted-platform
tuple whose producer can transfer independently from a legacy authority to
Buck.

**Execution Tool Descriptor** identifies an immutable executable provider,
protocol, execution platform, runtime contract, entrypoint, and bytes.

**Build Product Descriptor** is the canonical description of normalized
Buck-produced bytes, entrypoints, target-platform/runtime contract, and
result-affecting provenance crossing into Nix.

**Import Receipt** describes independent verification and any system-specific
composition applied after the normalized artifact crossed into Nix.

**Native Evidence** is Buck's event log, build report, and supported log-query
records. A compact receipt may index these records but does not supersede them.

**Admission** is the evidence-backed grant of a capability to an exact target,
platform, toolchain, policy, and trust tuple. _Avoid_: supported, when the exact
admitted capability is not named.

**No Verdict** means required evidence could not be observed. It is neither a
semantic pass nor failure, even when policy fails closed because no verdict is
available.

**Compatibility Surface** is a temporary alias, wrapper, shadow producer, or
differential path retained only to transfer authority. It must name its deletion
condition.

## Structure

```text
Semantic Package Model
  -> Semantic Graph
     -> Projection
        -> Buck target/action
           -> Build Product Descriptor
              -> Import Receipt
                 -> managed generation

Execution Platform + Target Platform + tool identity
  -> action identity

Native Evidence + semantic identities
  -> verification verdict
  -> Admission
  -> retirement of Compatibility Surface
```

## Flagged Ambiguities

- Qualify **platform** as target or execution platform.
- Use **operation** for semantic intent and **action** for a concrete Buck
  execution node.
- Use **projection** only for derived checked-in graph data, not the semantic
  source or a mutable dependency installation.
- Name the exact admission capability: local execution, cache read, cache
  write, remote execution, artifact publication, import, or activation.
- Distinguish artifact **normalization** in Buck from system **composition** in
  Nix.
