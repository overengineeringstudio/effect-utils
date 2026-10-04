# Platforms and Toolchains Requirements

This subsystem owns configured platform and exact executable identity.
It refines BUILD.BUCK-R04 and BUILD.BUCK-R05.

## Assumptions

- **BUILD.BUCK.PLAT-A01 Input authority:** Reviewed pins name immutable executables and
  data used by Buck; Nix may independently verify and consume the same bytes.
- **BUILD.BUCK.PLAT-A02 Distinct platforms:** Target and execution platforms are
  independent compatibility dimensions.
## Acceptable Tradeoffs

- **BUILD.BUCK.PLAT-T01 Finite stage zero:** A minimal support tool may begin as an exact
  Nix-produced provider outside the graph; once the graph reproduces the same
  contract, consumers move to the graph-built provider and the bootstrap
  provider is removed
  ([decision 0010](../../.decisions/0010-admit-rust-stage-zero-support-tools.md)).
## Requirements

### Platforms and tools

- **BUILD.BUCK.PLAT-R01 Configured platforms:** Every admitted action selects an explicit
  target platform and execution platform
  ([decision 0003](../../.decisions/0003-platform-proof-and-rust-convergence.md)).
  Platform labels are canonical and shared across composition shapes: the
  label, not its content, enters the configuration hash
  ([BUILD.BUCK.ROOT-R05](../03-consumer-roots/requirements.md#requirements)).
- **BUILD.BUCK.PLAT-R02 Exact tools from the store:** Every executable provider binds tool
  bytes, protocol, runtime requirements, and execution-platform compatibility,
  and resolves through `/nix/store` paths. Per-worktree tool paths are
  forbidden: they enter action command lines and split cache keys
  ([decision 0009](../../.decisions/0009-admitted-prelude-live-origin.md);
  [decision 0029](../../.decisions/0029-official-go-release-toolchain.md)).
- **BUILD.BUCK.PLAT-R03 No ambient discovery:** An action must not discover an
  authoritative executable through `PATH`, shell startup, or mutable host
  state; missing or incompatible providers fail closed without selecting a
  legacy producer.
- **BUILD.BUCK.PLAT-R04 Narrow invalidation:** A tool or platform change invalidates
  exactly the actions consuming the changed identity.
- **BUILD.BUCK.PLAT-R05 Nix-owned Darwin capability:** Darwin compilation, linking,
  signing, and inspection use exact Nix-provided Rust, LLVM, cctools, Apple
  SDK, and sigtool identities; actions must not discover Xcode, `xcrun`, or
  `/usr/bin` tools.

