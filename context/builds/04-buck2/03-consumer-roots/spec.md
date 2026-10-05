# Composition Spec

This document specifies the standalone repository root and the boundary between
Buck roots and megarepo source mounts. It builds on
[requirements.md](./requirements.md).

## Status

Active.

## Scope

**Defines:** the standalone root shape, its capability cell, conventional
toolchain resolution, and what a member source mount is to Buck.

**Does not define:** member semantics (01), platforms (02), cache wiring (04),
or artifact distribution (decision 0037).

```text
repository checkout = Buck project root           megarepo workspace
  .buckroot .buckconfig BUCK                        repos/<member>  -> source mount
  .buck2/capabilities -> /nix/store/…-buck2-capabilities    (never a Buck cell)
  buck2/platforms  buck2/toolchains
```

## Standalone Root

Each repository's tracked checkout is its Buck project root (BUILD.BUCK.ROOT-R01). Its
tracked `.buckconfig` has this shape:

```ini
[cells]
  <canonical-cell> = .                   # BUILD.BUCK.ROOT-R03
  capabilities = .buck2/capabilities     # Nix-produced projection
  prelude = prelude
[cell_aliases]
  config = prelude
  ovr_config = prelude
  fbsource = prelude
  toolchains = <canonical-cell>
[external_cells]
  prelude = bundled
[parser]
  target_platform_detector_spec = target:<canonical-cell>//...-><platform-package>:host_platform
[build]
  execution_platforms = <platform-package>:host_execution_platform
```

The tracked `.buckroot` keeps Buck from discovering an outer project
(BUILD.BUCK.ROOT-R06). The detector spec covers every cell (BUILD.BUCK.ROOT-R04). Platform labels
are effect-utils' `buck2/platforms` `host_platform` / `host_execution_platform`
targets (BUILD.BUCK.ROOT-R05). Each root has one fixed isolation dir (BUILD.BUCK.ROOT-R07).

A consumer root (`nix/buck2-products/consumer-root.nix`) has the same shape
with one more cell, `rules = .buck2/rules`: the shipped rules product, which
also carries the prelude. Its platform labels are
`rules//buck2/platforms:host_platform` and `…:host_execution_platform`.

## Checkout File Watching

```text
devenv preparation -> worktree-owned Watchman socket -> Buck daemon
                  -> capability link switch + Buck restart (only on change)
```

The effect-utils checkout uses `file_watcher = watchman`. Genie authors
`.watchmanconfig` from `.watchmanconfig.genie.ts`: generated editor caches,
`buck-out`, `.devenv`, `target`, `tmp`, `node_modules`, and `.git` are excluded
before traversal. The three editor-cache roots lead the list because macOS
accelerates only the first eight exclusions. Package sources and
`.buck2/capabilities` remain watched (BUILD.BUCK.ROOT-R07).

Devenv exports `WATCHMAN_SOCK` for a worktree-keyed, owner-only directory under
`/tmp`; the short socket path also fits Darwin's Unix socket limit. An owned
`WATCHMAN_CONFIG_FILE` sets `min_acceptable_nice_value` to 19. Per-worktree
ownership permits start/stop and exclusion changes without touching another
worktree or the user's shared daemon.

- `devenv tasks run buck2:watchman:start` starts or reuses that daemon.
- `devenv tasks run buck2:watchman:stop` stops that root's Buck daemon and its
  owned Watchman daemon. Run stop then start after changing `.watchmanconfig`;
  exclusions are not reloaded on an existing watch.
- Shell entry and Buck tasks prepare Watchman and run
  `buck2:capabilities:refresh`. Under the capability lock, a changed immutable
  generation restarts Buck and atomically switches `.buck2/capabilities`.
  An unchanged generation preserves the warm daemon. Buck retains external-cell
  roots across symlink retargeting, so watching the link alone is insufficient.
  Direct Buck callers must refresh after a Nix generation change; custom
  isolation directories require their own explicit daemon restart.

Fixed-source Nix sandbox builds select `fs_hash_crawler` in their temporary
`.buckconfig.local` before daemon startup; they do not depend on a host service
or use that backend for an incremental checkout.

## Capability Cell

The devenv shell links the pure `packages.<system>.buck2-capabilities` output
at `.buck2/capabilities`; no projector runs during shell entry. Nix derives the
projection from the tracked `buck2-member.json` capability manifest and the
flake packages it names: `capability-projection.ts` resolves each executable,
its digest, and its closure, and renders the per-tool `BUCK`, `manifest.json`,
and generation-keyed `defs.bzl`. Toolchains load `capabilities//:defs.bzl`.
Consumer roots take the same output from effect-utils' flake.

Consumer-specific native inputs extend that producer projection through
`effect-utils.lib.mkBuck2Capabilities { pkgs; extraCapabilities = { … }; }`;
the result replaces the capability output in both the consumer's Nix-built
standalone root and its local `buck2:materialize-root` path. The producer
manifest remains authoritative for shared tools. Extension keys are unique
lowercase-kebab capability IDs and cannot shadow a producer ID. Each entry
declares `kind = "directory" | "executable"`, a Nix `package`, a `protocol`,
and `executable = "bin/<name>"` only for executable inputs. The shared
projector merges entries, resolves every immutable `/nix/store` output and its
complete `closureInfo` requisites, and emits a single generation.

```text
producer buck2-member.json ─┐
                             ├─> one capability projection ─> consumer root + local root
consumer extraCapabilities ─┘          │
                                       └─> Buck store_directory / support_tool
```

Executables retain `native-executable/v1` manifests. Directory inputs have
`immutable-directory/v1` manifests with a `directoryStorePath`, the complete
sorted store closure, and a SHA-256 digest of the immutable output path (not
of an unbounded directory walk). Their Buck target exports the directory and
manifest from the same generation, so `$(location //buck2/toolchains:<input>)`
in a Reindeer buildscript environment is a declared action input, not ambient
host state. The consumer owns the Nix derivation and the local Buck declaration;
the generic rules contain no consumer or vendor-specific source paths
(BUILD.BUCK.ROOT-R03, BUILD.BUCK.ROOT-R05).

`buck2-member.json` (schema version 2) declares only capabilities:

```json
{
  "schemaVersion": 2,
  "capabilities": [
    { "toolId": "buck2", "protocol": "…", "flakePackage": "buck2", "executable": "bin/buck2" },
    {
      "_tag": "ToolchainAuthority",
      "toolchain": "tsgo",
      "provides": [{ "toolId": "effect-tsgo", "…": "…" }]
    }
  ]
}
```

A tool id appears once across direct capabilities and every authority's
`provides`; a toolchain kind has at most one authority.

## Conventional Toolchains

Because `[cell_aliases] toolchains = <canonical-cell>` makes `toolchains//:<name>`
resolve to `<canonical-cell>//:<name>`, the conventional targets prelude looks
up live in the root package, each a native `toolchain_alias` onto the real
`//buck2/toolchains:<name>` target (`alias` cannot front an
`is_toolchain_rule = True` target; `toolchain_alias` is itself a toolchain
rule). `genrule` is the one exception: `GenruleToolchainInfo` carries only
`zip_scrubber = None`, so the root instantiates prelude's own
`system_genrule_toolchain` and pins nothing. Every prelude rule — including
prelude's internal Rust tools, which are `python_bootstrap_binary` targets —
therefore finds exactly one instance of each conventional toolchain, and it is
the capability-backed one.

The bootstrap interpreter those prelude tools need is admitted in exactly one
realization — the hermetic, Nix-realized `python_bootstrap` toolchain of
[decision 0028](../../.decisions/0028-hermetic-python-bootstrap-for-consumer-cells.md).
Ambient interpreters and CPython build edges stay refused, mechanically, by
`nix/devenv-modules/tasks/shared/tests/buck2-no-python-actions.test.sh`.

## Source Mounts

`mr apply` places each member at `repos/<name>` as a symlink into the megarepo
store (branch, tag, or commit worktree). A source mount exists for reading,
editing, and running the member's own tooling from its own root; it is never a
Buck cell (BUILD.BUCK.ROOT-R02). A repository that needs another repository's outputs
consumes its published artifacts through Nix substitution or the
manifest-derived registry, never its mount. Because a mount is an absolute
symlink, Buck could not see its content anyway (BUILD.BUCK.ROOT-R08).

The composed Buck root — a synthesized `.buckconfig` spanning `repos/<member>`
cells, read-only `cp -a` mounts, dist overlays, and a per-workspace capability
resolver — is retired (principal q5, 2026-09-25). `mr store worktree new`
creates only standalone worktrees.

## Invariants Worth Restating

- The root cell's own name does not enter action identity; cell name, platform
  label, and isolation dir do.
- Presence of additional targets does not perturb an unrelated target's
  digests.
- Cross-cell `load()` of the shipped rules cell works; shared rules stay free
  of private facts (BUILD.AUTH-R14).

## RE Overlay and Source Cell Mapping

Root preparation materializes the [reuse client overlay](../06-reuse-client/spec.md#client-contract)
before daemon startup; CLI overrides do not reach RE. `mkConsumerBuckRoot` uses
`engineAddress` defaulting to the action-cache address rather than omitting
`engine_address` ([#1596](https://github.com/overengineeringstudio/effect-utils/pull/1596)).
`patchSourceCells` maps declared producer source cells to the shipped consumer
rules cell while preserving the consumer repository's source labels
([#1598](https://github.com/overengineeringstudio/effect-utils/pull/1598)). This is
root materialization, not a new cross-repository graph or cache policy.

## Open Design Questions

- **BUILD.BUCK.ROOT-DQ01 Worktree edit-loop preparation:** Per-worktree devenv
  PATH links built Buck products into a worktree-local bin directory placed first
  on PATH (axe record `73o54a`). This directory is a runtime consumer surface, not
  an executable provider path entering action keys. The long-term devenv dependency
  is unsettled, blocked on a devenv-versus-alternatives bakeoff measuring startup,
  edit-run ergonomics and retained complexity. Consumer profiles own fleet binding.
