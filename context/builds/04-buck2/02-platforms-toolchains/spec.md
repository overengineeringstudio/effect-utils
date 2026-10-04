# Platforms and Toolchains Spec

This document specifies configured platforms and executable providers. It builds on
[requirements.md](./requirements.md).

## Status

Active.

## Scope

Owns target/execution compatibility and exact tools; action lifecycle belongs to
[execution](../05-execution/spec.md).

## Platforms

| Product platform label            | Execution platform label               | OS     | Architecture | ABI    | Native executable contract |
| --------------------------------- | -------------------------------------- | ------ | ------------ | ------ | -------------------------- |
| `//buck2/platforms:linux_x86_64`  | `//buck2/platforms:exec_linux_x86_64`  | linux  | x86_64       | glibc  | `elf-dynamic/v1`           |
| `//buck2/platforms:linux_aarch64` | `//buck2/platforms:exec_linux_aarch64` | linux  | aarch64      | glibc  | `elf-dynamic/v1`           |
| `//buck2/platforms:macos_aarch64` | `//buck2/platforms:exec_macos_aarch64` | darwin | aarch64      | darwin | `mach-o-dynamic/v1`        |

Platform targets live in one canonical cell present in every composition
(effect-utils as the hub), so the same labels resolve everywhere
(BUILD.BUCK.PLAT-R01). Host detection may select among declared tuples for an interactive
alias; the configured tuple becomes part of action and evidence identity and is
never inferred during import. The `build_product` macro requires the intended
product platform explicitly and compares all resolved platform fields against
`ProductExecutableInfo` before packaging — a checked join, not a second
platform authority.

## Executable Providers

```text
BuckSupportToolInfo {
  toolId, contentDigest, executable, executableStorePath,
  closureIdentity, protocol, executionPlatform, runtimeContract
}
```

Provider descriptors are data read before execution; they never permit actions
to evaluate Nix. Devenv preparation projects exact files under the stable
`.buck2/capabilities/` cell in complete immutable generations; the
authoritative `defs.bzl` is atomically replaced only after a generation is
complete, and a missing or stale projection fails closed. Actions using
executor-local projected tools are explicitly local-only. Toolchain
executables referenced in action command lines are `/nix/store` paths
(BUILD.BUCK.PLAT-R02).

`local-only` constrains execution placement; it does not disable shared action
cache reads or writes. For an admitted local action, the canonical
`/nix/store` realization path participates in the action key and binds the
immutable local tool identity; the typed provider also binds protocol, runtime
requirements, and exact execution-platform compatibility. Stage-zero
capability descriptors additionally record explicit content and closure
identities. The executable remains executor-local and is not transported
through the Buck CAS.

Remote execution requires the portable archive or execution-image contract
from dependency-materialization
[decision 0006](../../../dependency-materialization/05-buck2-evidence/.decisions/0006-nix-exported-buck-toolchains.md);
shared-cache reuse of a local action does not imply that contract has been met.

Under BUILD.BUCK-R17 the contract is realized as a worker image: an execution
platform names the Nix closure that provides every tool its actions bind, a
worker advertises the closures it holds as platform properties, and the
scheduler places a cache miss only on a worker whose properties match. The
first backend evaluated is NativeLink (cache, scheduler, one x86_64-linux
worker) after the BUILD.BUCK-R06 key-stability delta is closed; the rerunnable kit is
in `.experiments/2026-09-19-nativelink-remote-execution.md`.

A stage-zero provider binds an exact Nix realization identity, executable,
protocol, and execution-platform constraint; a negative test proves an
undeclared ambient copy is ignored; a graph-built replacement retires it
(BUILD.BUCK.PLAT-T01).

## Darwin Capability

The Apple SDK is an executor-local Nix capability referenced by the compiler
environment, not a Buck dependency or CAS input. Preflight fails before Buck
when any exact tool or SDK root is absent. Compilation sets an invalid
`DEVELOPER_DIR` deliberately so Xcode and `xcrun` cannot become an implicit
fallback; inspection binds Nix cctools and sigtool identities. Native
execution remains the proof that an ad-hoc signature is accepted by macOS.

## Darwin Compiler SDK Wrappers

A compiler wrapper may expose the declared Nix Apple SDK to Zig or another
compiler, but the wrapper and SDK must be exact projected capabilities. It
must not discover Xcode or `xcrun` from the host. This supplies the Darwin
capability contract without placing a consumer/vendor selection in shared rules
(BUILD.BUCK.PLAT-R05).
