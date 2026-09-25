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

Each repository's tracked checkout is its Buck project root (COMP-R01). Its
tracked `.buckconfig` has this shape:

```ini
[cells]
  <canonical-cell> = .                   # COMP-R03
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
(COMP-R06). The detector spec covers every cell (COMP-R04). Platform labels
are effect-utils' `buck2/platforms` `host_platform` / `host_execution_platform`
targets (COMP-R05). Each root has one fixed isolation dir (COMP-R07).

A consumer root (`nix/buck2-products/consumer-root.nix`) has the same shape
with one more cell, `rules = .buck2/rules`: the shipped rules product, which
also carries the prelude. Its platform labels are
`rules//buck2/platforms:host_platform` and `…:host_execution_platform`.

## Capability Cell

The devenv shell links the pure `packages.<system>.buck2-capabilities` output
at `.buck2/capabilities`; no projector runs during shell entry. Nix derives the
projection from the tracked `buck2-member.json` capability manifest and the
flake packages it names: `capability-projection.ts` resolves each executable,
its digest, and its closure, and renders the per-tool `BUCK`, `manifest.json`,
and generation-keyed `defs.bzl`. Toolchains load `capabilities//:defs.bzl`.
Consumer roots take the same output from effect-utils' flake.

`buck2-member.json` (schema version 2) declares only capabilities:

```json
{
  "schemaVersion": 2,
  "capabilities": [
    { "toolId": "buck2", "protocol": "…", "flakePackage": "buck2", "executable": "bin/buck2" },
    { "_tag": "ToolchainAuthority", "toolchain": "tsgo", "provides": [ { "toolId": "effect-tsgo", "…": "…" } ] }
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
[decision 0028](../.decisions/0028-hermetic-python-bootstrap-for-consumer-cells.md).
Ambient interpreters and CPython build edges stay refused, mechanically, by
`nix/devenv-modules/tasks/shared/tests/buck2-no-python-actions.test.sh`.

## Source Mounts

`mr apply` places each member at `repos/<name>` as a symlink into the megarepo
store (branch, tag, or commit worktree). A source mount exists for reading,
editing, and running the member's own tooling from its own root; it is never a
Buck cell (COMP-R02). A repository that needs another repository's outputs
consumes its published artifacts through Nix substitution or the
manifest-derived registry, never its mount. Because a mount is an absolute
symlink, Buck could not see its content anyway (COMP-R08).

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
  of private facts (BUCK-R14).
