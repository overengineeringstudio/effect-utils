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
first candidate is Namespace; adoption is deferred under
[decision 0039](../../.decisions/0039-namespace-first-remote-candidate-adoption-deferred.md).
The Linux proof uses one immutable named pool per capability closure identity.
Worker startup realizes the complete Nix closure, including the capability
projection root, before registration. Client links point directly to that
`/nix/store` projection root because exported symlinks contain absolute paths.
Platform properties bind the pool and closure identity into the action key.
The [experiment](../../.experiments/2026-09-30-namespace-remote-execution.md)
proves this mechanism, not production admission or a substitutable Darwin graph.

A stage-zero provider binds an exact Nix realization identity, executable,
protocol, and execution-platform constraint; a negative test proves an
undeclared ambient copy is ignored; a graph-built replacement retires it
(BUILD.BUCK.PLAT-T01).

## Capability Publication

```text
realized Nix profile
  -> exclusive capabilities.lock
  -> indirect GC root + complete immutable generation
  -> atomic defs.bzl publication in the real capabilities cell
  -> daemon-state-gated retention
```

`scripts/buck2-capability-publish.ts` owns the worktree projection for shell
activation and Buck task preparation (BUILD.BUCK.PLAT-R02). The cell root is a
real directory, not a retargetable symlink. Buck's watchers receive a change to
the actual `capabilities//defs.bzl` file, which invalidates the loaded generation
map. Retargeting a cell-root symlink only invalidates the root path and does not
invalidate cached descendant Starlark reads.

Publishers serialize through an operating-system file lock on
`.buck2/capabilities.lock`. They install each complete generation before
atomically replacing `defs.bzl` on the same filesystem. Migration from an
existing root symlink prepares a complete real cell and atomically exchanges
the two entries; readers never encounter a deleted live root. Generation BUCK
and manifest files are real files. Executable and directory links retain their
per-tool Nix targets, so action inputs do not acquire an aggregate profile hash.

The one-time symlink-to-directory transition changes native watch topology.
After publishing the complete real cell, the publisher explicitly invokes
`buck2 kill` for each isolation recorded in this worktree's Buck state directory
and logs the scope. This lifecycle boundary prevents old symlink watches from
retaining descendant DICE state. A durable `.buck2/capabilities.migration`
marker records the obligation before the exchange and is cleared only after
all native stop commands succeed. Interrupted migration is resumed on the next
publication. Steady-state publication never stops a daemon.

Each retained generation has a registered indirect Nix GC root under
`.buck2/capability-roots/`, pointing to its aggregate profile. This retains the
profile and its complete referenced tool closures even after the activating
shell's profile changes.

Retention keeps the three most recently published generations, including the
current one, only at a daemon-free publication boundary. The publisher checks
Buck's worktree-specific `buckd.pid` files across every isolation directory
after publishing the current definition map. Any live daemon, unreadable or
ambiguous state defers pruning and retains all generations and their GC roots.
An idle daemon may still reference an arbitrarily old generation, so age or
count alone is not permission to prune. The bound is restored on a later
daemon-free publication; pruning never stops a daemon.
Pruning atomically detaches a generation into `.buck2/capability-trash/` before
recursively deleting it. The detached tree remains a retry marker until its old
GC root and publication receipt are removed; the next publication completes
interrupted cleanup before installing incoming generations. Cleanup restores
owner-write permission on detached directories without following tool links.
A partial deletion can never occupy a recognized `generations/<generation>` identity.

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

`swift_app_bundle` admits `macos_aarch64`. Each named binary compiles its
ordered Swift source list through one declared `BuckSupportToolInfo` compiler
capability, with explicit deployment target, frameworks, and libraries.
The Nix wrapper supplies the exact SDK, compiler, and linker; the action sets
invalid host `DEVELOPER_DIR` and `SDKROOT` values so ambient Xcode discovery
cannot replace the capability. Packaging uses the product tool and the
[app-bundle contract](../../05-product-distribution/01-product-contract/spec.md#darwin-app-bundles).

The compiler runs at its immutable `BuckSupportToolInfo.store_path`; its
executable and capability manifest remain action inputs. Generic support-tool
`RunInfo` flags are not compiler arguments. The shared Swift runner sets
`-module-cache-path`, `CLANG_MODULE_CACHE_PATH`, and `SWIFT_MODULECACHE_PATH`
to `BUCK_SCRATCH_PATH/modules`; missing scratch or a consumer override fails
closed. Neither Swift nor Clang may reuse ambient host module caches.
