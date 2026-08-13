# 0006 Nix Exported Buck Toolchains

Status: accepted

## Context

Nix/devenv currently pins Buck, pnpm, Bun/Node, tsgo, Rust, and other tools.
Authoritative Buck actions need exact tool bytes and configuration in their
action identity without invoking Nix evaluation per action or assuming another
host has identical `/nix/store` paths.

Simple runtimes and static tools can be exported as relocatable per-platform
archives. Complex native closures are more naturally represented by an
execution image whose digest participates in Buck platform identity.

## Evidence and Argument

- The user selected Nix-exported toolchains in q6.
- Direct warm Buck invocation was materially faster than launching it through
  fresh Nix/devenv evaluation, so Nix cannot sit inside the hot action path.
- Raw store paths do not transport to remote workers and may hide undeclared
  runtime closure dependencies.
- Keeping recipes and pins in Nix avoids a second tool-version/provenance
  authority while Buck's declared toolchain providers preserve precise action
  identity.

## Options

| Option                                                           | Tradeoffs                                                                                                                                          |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Nix pins/builds and Buck consumes verified portable artifacts | Preserves one authority and portable action keys; requires publication, relocation tests, and execution-image support for complex native closures. |
| B. Buck independently pins and downloads upstream tools          | Uses Buck-native distribution directly; duplicates pin/provenance authority and can drift from Nix system artifacts.                               |

## Decision

Choose A.

Nix owns tool recipes, versions, patches, and provenance. It exports normalized
per-platform archives plus generated digest manifests for tools proven
relocatable. Buck consumes those artifacts as declared toolchain dependencies.
When a closure cannot be made simply relocatable, Nix produces an execution
image and its immutable image digest becomes part of the Buck execution
platform.

Raw `/nix/store` executables are allowed only in explicitly local,
evidence-only bootstrap targets with remote cache reads/writes and remote
execution disabled.

## Consequences

- Authoritative actions never invoke Nix evaluation or the Nix daemon.
- Admission requires store-reference scans, execution with a hostile/empty
  ambient `PATH`, cross-worktree and cross-host replay, byte-stable archives,
  and freshness checks from Nix recipe to generated digest manifest.
- The toolchain provider hides archive-versus-image implementation so consumers
  and labels remain stable.
- Linux remote execution can graduate to Nix-built execution images; macOS
  remains an explicit per-platform archive/local execution lane unless a
  suitable remote platform is proven.
- Toolchain, normalization ABI, and execution-image changes are distinct
  observable invalidation dimensions.
