# Buck2 execution platforms: specification

## Contract overview

```text
                        recipe and pin authority
                +----------------------------------+
                |               Nix                |
                | sources, locks, SDKs, stage 0    |
                +----------------+-----------------+
                                 |
                    artifact + exact descriptor
                                 |
                +----------------v-----------------+
                | configured execution platform   |
                | constraints + tool identities   |
                +----------------+-----------------+
                                 |
                         Buck tool provider
                                 |
                +----------------v-----------------+
                | repository-local Buck action    |
                | explicit inputs, outputs, args  |
                +----------------+-----------------+
                                 |
                   cache/local/remote execution
```

The descriptor is the bridge. Nix determines how a tool is produced; Buck
determines where that exact tool is consumed. Neither layer reconstructs the
other's graph.

## Platform identities

### Constraint dimensions

Configured platforms use explicit constraint values for:

| Dimension          | Examples                              | Meaning                        |
| ------------------ | ------------------------------------- | ------------------------------ |
| OS                 | `linux`, `darwin`                     | Kernel/userland contract       |
| architecture       | `x86_64`, `aarch64`                   | Executable instruction set     |
| runtime ABI        | `glibc-dynamic`, `darwin`, `portable` | Runtime loader/ABI expectation |
| execution locality | `local-store`                         | Current admitted tool delivery |

Target and execution platform labels are separate even when their constraint
sets are initially equal. A target label describes outputs; an execution label
describes workers and action tools.

### Initial labels

The first implementation should declare labels shaped like:

```text
//buck2/platforms:target_x86_64_linux_glibc
//buck2/platforms:target_aarch64_linux_glibc
//buck2/platforms:target_x86_64_darwin
//buck2/platforms:target_aarch64_darwin

//buck2/platforms:exec_x86_64_linux_local_store
//buck2/platforms:exec_aarch64_linux_local_store
//buck2/platforms:exec_x86_64_darwin_local_store
//buck2/platforms:exec_aarch64_darwin_local_store
```

A future delivery mechanism adds a constraint value only after a current
consumer and admission proof justify it. A target detector may map a local
command to one of the current labels, but rules consume the resulting
constraints and do not inspect the daemon host.

### Resolution

For every platform-sensitive action:

1. Resolve the configured target platform.
2. Resolve an execution platform compatible with every exec dependency.
3. Select a toolchain whose declared target/execution pair matches.
4. Validate each descriptor against the selected execution platform.
5. Construct the action with exact artifacts in its inputs.
6. Fail analysis if no compatible pair exists.

A canonical Nix store path is an identity hint, not an architecture check. The
descriptor platform and configured constraints must agree before execution.

## Nix export contract

### Recipe source

One Nix module owns each tool recipe and platform matrix. It consumes pinned
flake/lock inputs and produces independent derivations for independently keyed
helpers. It must not generate BUCK target topology.

Conceptual output:

```text
buck2-build-tools
|-- x86_64-linux
|   |-- closure-tool
|   |-- package-evidence-tool
|   `-- helper
|-- aarch64-linux
|   `-- ...
|-- x86_64-darwin
|   `-- ...
`-- aarch64-darwin
    `-- ...
```

The implementation uses separately addressable derivation outputs. Supplying
one broad store root to all actions would erase the desired helper-level cache
boundary.

### Descriptor schema

Each exported tool has a canonical JSON descriptor equivalent to:

```json
{
  "schemaVersion": 1,
  "kind": "buck2-execution-tool",
  "name": "closure-tool",
  "contractVersion": 1,
  "platform": "x86_64-linux",
  "runtimeAbi": "portable",
  "entrypoint": "bin/closure-tool",
  "artifact": {
    "format": "nix-store-path",
    "digest": "sha256:<content-digest>",
    "sizeBytes": 1234
  }
}
```

Canonical serialization, field validation, and version evolution belong to one
shared schema. The descriptor digest and artifact digest are both pinned in the
Buck configuration or a generated immutable configuration file. A separate
evidence record may join source revision, Nix recipe/lock identity, and producer
provenance to the descriptor. Those facts do not perturb action identity when
the executable contract and bytes are unchanged.

## Stage-0 bootstrap

### Bootstrap graph

```text
Nix compiler/tool recipe
        |
        v
Nix-built stage0 helper ------------------+
        |                                 |
        | executes Buck action            | validates/stages toolchain
        v                                 v
Buck-built helper twin             portable toolchain tree
        |
        v
parity evidence only
```

The stage-0 helper never depends on the Buck-built twin. A helper that verifies
or materializes a tool payload never consumes the payload needed to run itself.
This ordering breaks the bootstrap cycle explicitly.

### Single source, two realizations

Nix stage 0 and the Buck twin consume the same source tree and dependency lock.
They are not interchangeable authorities:

- the Nix realization is the admitted bootstrap executable;
- the Buck realization proves that the repository graph can reproduce the
  contract and becomes a candidate for later actions that do not bootstrap it.

Admission compares canonical output bytes and adversarial behavior. Executable
bytes need not match across different linkers or platforms; their descriptors
must prove the same source, lock, contract version, and intended platform.

## Current Delivery

The current provider exposes an immutable Nix store executable through
`RunInfo` plus exact descriptor identity. It is local-only. Portable or remote
delivery is deliberately unspecified until an experiment proves a current
consumer and a smaller winning contract.

### On-demand Prelude CPython closure

Targets that use Prelude Python rules currently trigger an on-demand CPython
live-origin dependency. Starlark rule loading itself does not require this
tree. For the actions that consume it, the interpreter is declared stage-0
input rather than ambient infrastructure:

```text
reviewed source/recipe pin
          |
          v
optional digest-addressed OCI source retrieval
          |
          v
reviewed Nix stage-0 realization
          |
          v
exact descriptor + content digest
          |
          v
Buck Python action-toolchain input
```

While Python actions remain, the admitted origin is an immutable Nix stage-0
realization. Nix owns the reviewed source expectation, recipe,
runtime-closure pin, and realized descriptor, while Buck consumes only the
exact staged tree. Nix may retrieve
the expected source bytes by digest from self-hosted OCI storage, applying the
same untrusted-transport principle as product publication, but this retrieval
does not use or depend on the Buck-product importer in
`04-artifact-system-bridge`. Direct upstream fetches during Buck analysis or
action-toolchain construction, floating revisions, registry tags, ambient
`python`, and mutable checkout paths fail bootstrap admission. Transport may
replace where Nix obtains expected bytes, but it does not replace the reviewed
Nix pin or tool descriptor as authority. Repository-owned support tools
converge to fine-grained Rust binaries from the shared Cargo workspace. That
measured contraction removes
the Prelude Python consumers; eliminating the then-unused live origin is a
separate deletion gate, not a requirement to fork Prelude.

## Provider shape

A platform tool provider should expose the smallest stable contract:

```text
ExecutionToolInfo
|-- run_info
|-- descriptor
|-- descriptor_digest
|-- artifact_digest
|-- execution_platform
|-- runtime_abi
|-- bootstrap_kind: stage0 | twin
`-- delivery: local_store
```

Compiler toolchains may aggregate several tools when the compiler contract
requires them to change together. Leaf helpers remain separate exec deps.
Packaging-only, test-only, and lint-only providers are attached only to their
respective actions.

## Fail-closed rules

Analysis or toolchain resolution rejects:

- absent or unknown platform dimensions;
- an artifact descriptor for a different execution platform;
- unsupported target/execution pairs;
- a local-store tool selected for portable/remote execution;
- an undeclared entrypoint or mismatched runtime ABI;
- a stage-0 verifier that transitively consumes the artifact it verifies.

Execution-time `Exec format error` is a failed admission control: architecture
incompatibility should have been rejected earlier.

## Cache and invalidation contract

The action key includes the exact consumed helper or toolchain artifact. It does
not include unrelated members of the Nix tool set.

Required controls:

| Mutation                     | Expected action effect                |
| ---------------------------- | ------------------------------------- |
| File mtime only              | zero actions                          |
| Packaging helper identity    | packaging actions only                |
| Test helper identity         | test actions only                     |
| Lint helper identity         | lint actions only                     |
| Compiler identity            | compile/link graph, as declared       |
| Build provenance             | stamped leaf only                     |
| Wrong execution architecture | analysis/toolchain-resolution failure |

## Observability Boundary

Receipts and event-log projections should carry stable attributes:

```text
buck.target_platform
buck.execution_platform
buck.tool.name
buck.tool.contract_version
buck.tool.artifact_digest
buck.tool.descriptor_digest
buck.tool.bootstrap_kind
buck.tool.delivery
buck.execution.kind
buck.materialized.bytes
buck.cache.outcome
```

The evidence subsystem owns receipt schemas and verdicts. This subsystem only
exposes platform and selected-tool facts to that contract. Repository-owned
helper implementation language is not part of this stable provider contract.

## Mechanism Admission

A new delivery mechanism is introduced only for a declared consumer and from
comparative evidence; it does not receive speculative interface support.
Repository-owned Python-helper removal is its own measured delta and is not a
prerequisite for this platform contract. Until the last Prelude Python consumer
is removed, its on-demand live-origin closure must satisfy `BUCK.PLAT-R013`;
language purity is not an exemption from bootstrap integrity.
