# Execution Platform Requirements

This subsystem defines declared tools and configured platforms. It refines
BUCK-R03, BUCK-R05, and BUCK-R08.

## Assumptions

- **BUCK.PLAT-A01 Input authority:** Reviewed pins name immutable executables
  and data used by Buck; Nix may independently verify and consume those bytes.
- **BUCK.PLAT-A02 Distinct platforms:** Target and execution platforms are
  independent compatibility dimensions.

## Acceptable Tradeoffs

- **BUCK.PLAT-T01 Finite stage zero:** A minimal support tool may begin as an
  exact Nix-produced provider outside the graph. Once the graph can reproduce
  the same contract, consumers move to the graph-built provider and the
  bootstrap provider is removed.

## Requirements

### Must declare complete execution identity

- **BUCK.PLAT-R01 Configured platforms:** Every admitted action must select an
  explicit target platform and execution platform.
- **BUCK.PLAT-R02 Exact tools:** Every executable provider must bind tool bytes,
  protocol, runtime requirements, and execution-platform compatibility.
- **BUCK.PLAT-R03 No ambient discovery:** An action must not discover an
  authoritative executable through `PATH`, shell startup, or mutable host state.
- **BUCK.PLAT-R04 One-way input flow:** External artifact realization may
  precede Buck; a Buck action must not evaluate or repair Nix inputs.
- **BUCK.PLAT-R05 Fail closed:** Missing or incompatible providers and platforms
  must fail analysis or execution without selecting a legacy producer.

### Must make bootstrap finite

- **BUCK.PLAT-R06 Explicit stage zero:** A bootstrap tool must name its external
  producer, bytes, platform, protocol, and consumers.
- **BUCK.PLAT-R07 No self-bootstrap cycle:** A tool must not be required to
  produce the provider needed to load or execute its own defining graph.
- **BUCK.PLAT-R08 Narrow invalidation:** A tool or platform change must
  invalidate exactly the actions that consume the changed identity.
- **BUCK.PLAT-R09 Nix-owned Darwin capability:** Darwin compilation, linking,
  signing, and inspection must use exact Nix-provided Rust, LLVM, cctools, Apple
  SDK, and sigtool identities. The SDK remains executor-local; actions must not
  discover Xcode, `xcrun`, or `/usr/bin` tools or upload the SDK as a graph
  artifact.
