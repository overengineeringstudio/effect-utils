# Execution Platform Spec

This document specifies platform and executable-provider binding. It builds on
[requirements.md](./requirements.md).

## Status

Draft.

## Scope

**Defines:** configured platform identity, executable providers, and stage-zero
constraints.

**Does not define:** Nix product import or system realization.

## Input Flow

```text
Nix recipe + pin -> immutable tool result -> ignored capability projection
                                                   |            |
                                                   |            +-- manifest Artifact
                                                   |            `-- executable symlink Artifact
                                                   v
target platform + execution platform ----------> support-tool provider -> Buck action

graph-built support tool -----------------------------------+
```

Provider descriptors are data read before action execution. They name exact
entrypoints and content identity; they do not permit actions to evaluate Nix.
Devenv environment preparation atomically projects a content-addressed
generation under `.buck2/capabilities/<platform>/<tool>/`. Direct Buck
invocation does not realize or repair Nix: a missing or stale projection fails
closed. Run `devenv tasks run buck2:capabilities:project` before a direct raw
Buck invocation; every repository Buck task declares that preparation edge.
The executable and manifest are both source Artifacts in the action key.
Actions using executor-local projected tools are explicitly local-only.

## Provider Descriptor

```text
BuckSupportToolInfo {
  toolId
  contentDigest
  executable
  executableStorePath
  closureIdentity
  protocol
  executionPlatform
  runtimeContract
}
```

The configured action key includes the descriptor identity and selected target
and execution platforms. Repository adapters refer to logical `toolId` values;
consumer composition supplies the physical immutable provider.

## Admitted Native Platforms

| Product platform label            | Execution platform label               | OS     | Architecture | ABI    | Native executable contract |
| --------------------------------- | -------------------------------------- | ------ | ------------ | ------ | -------------------------- |
| `//buck2/platforms:linux_x86_64`  | `//buck2/platforms:exec_linux_x86_64`  | linux  | x86_64       | glibc  | `elf-dynamic/v1`           |
| `//buck2/platforms:linux_aarch64` | `//buck2/platforms:exec_linux_aarch64` | linux  | aarch64      | glibc  | `elf-dynamic/v1`           |
| `//buck2/platforms:macos_aarch64` | `//buck2/platforms:exec_macos_aarch64` | darwin | aarch64      | darwin | `mach-o-dynamic/v1`        |

Interactive host detection may select among these named platforms. Product
labels and evidence always carry the resolved tuple explicitly. An executable
producer is configured for its explicit target platform, declares matching
execution compatibility on the producing action, and returns the resolved
`ProductPlatformInfo` inside `ProductExecutableInfo`. The language-neutral
`build_product` rule consumes that typed provider and rejects its own
`default_target_platform`; it must not independently transition or reinterpret
the already-produced executable. Thus an ARM producer cannot silently execute
through an x86-only local capability, and packaging cannot relabel its output
as another target platform.

## Darwin Capability

```text
pinned nixpkgs
  +-- rustc + LLVM linker
  +-- cctools (otool, lipo, codesign_allocate)
  +-- Apple SDK
  `-- sigtool + signingUtils
             |
             v
   executor-local capability preflight
             |
             v
 stable Rust toolchain provider identity -> Buck action
```

The provider exposes a stable logical ABI and semantic identity. The Apple SDK
is an executor-local Nix capability referenced by the compiler environment, not
a Buck dependency or CAS input. Preflight fails before Buck when any exact tool
or SDK root is absent. Compilation sets an invalid `DEVELOPER_DIR` deliberately
and uses only the declared Nix SDK root, so Xcode and `xcrun` cannot become an
implicit fallback. Product inspection similarly binds Nix cctools and sigtool
identities rather than ambient `/usr/bin` tools. Native execution remains the
proof that a structurally present ad-hoc signature is accepted by macOS.

## Platform Resolution

Platform selection is an explicit repository-policy input. Unsupported tuples
fail before executing an action. Host detection may choose among already
declared tuples for an interactive alias, but the configured tuple becomes part
of action and evidence identity and is never inferred during product import.

## Stage-Zero Rule

A stage-zero provider binds an exact Nix realization identity, executable,
protocol, and execution-platform constraint. Its producer lies outside the
graph it enables, and a negative test proves an undeclared ambient copy is
ignored. Runtime attestation verifies the canonical store target, executable
byte digest, protocol, runtime contract, and native platform against the
manifest Artifact. A support tool that can be built by the enabled graph is exposed
through the same provider contract; consumers then move to that graph-built
target and the corresponding bootstrap provider is removed.
