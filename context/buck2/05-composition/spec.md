# Composition Spec

This document specifies the composition root and its generation. It builds on
[requirements.md](./requirements.md). The shape below is validated against the
real repositories
([.experiments/2026-08-26-composition-root-real-repos.md](./.experiments/2026-08-26-composition-root-real-repos.md)).

## Status

Draft.

## Scope

**Defines:** the composition root shape, its generator, and the standalone
variant.

**Does not define:** member semantics (01), platforms (02), or cache wiring
(04).

## Composition Root Shape

The mr-generated root `.buckconfig` (validated on real content):

```ini
[cells]
  <root-repo> = .
  prelude = prelude
  toolchains = toolchains
  none = none
  <member-cell> = repos/<member>       # one line per member, canonical name+path
[cell_aliases]
  config = prelude
  ovr_config = prelude
  fbcode = none
  fbsource = none
  fbcode_macros = none
  buck = none
[external_cells]
  prelude = bundled
[parser]
  target_platform_detector_spec = target:<root>//...-><hub>//buck2/platforms:host_platform \
                                  target:<member-cell>//...-><hub>//buck2/platforms:host_platform
[build]
  execution_platforms = <hub>//buck2/platforms:host_execution_platform
```

plus `toolchains/BUCK` containing `system_demo_toolchains()` (an EMPTY
toolchains cell breaks prelude rule resolution), empty `none/BUCK`, one
`.buckroot` at the root, and the cache client section (04). The detector spec
lists every cell explicitly (COMP-R04). The hub cell for platforms is
effect-utils; its real package is `buck2/platforms` with
`host_platform` / `host_execution_platform` targets (COMP-R05).

**Never emit `root = <root-repo>` in `[cell_aliases]`:** root-declared aliases
are visible in every cell, so the alias silently retargets a member's `root//`
references to the composition root. Without it the same reference is a loud
parse error naming the missing cell — the correct failure. Members are
therefore written cell-portable: no `root//` labels, no bare `toolchains//:`
labels (member-local labels instead).

## Generator

The generator is an mr library generator (beside the vscode and
nix-lock generators), consuming per composition: the member set with resolved
mount paths, the platform-hub member, and the isolation dir; and per member
(from a genie-projected member manifest read out of the mount): canonical cell
name, canonical mount path, `[project] ignore` contributions (rewritten
root-relative and unioned). `--isolation-dir` is CLI-only and cannot be pinned
by buckconfig, so mr also owns the invocation wrapper that fixes it
(COMP-R07); an unwrapped `buck2` call relies on the default and is consistent
by accident only.

Member repositories ship no `.buckconfig` project root of their own: deleting
effect-utils' `.buckconfig` is part of landing the generator, so the
unsupported bare-checkout shape fails loudly instead of silently building a
cache island. (A member's `.buckconfig` is inert under composition — only its
`[cell_aliases]` are honored — so nothing else is lost.) The gitignored
`.buck2/capabilities` cell is per-host projected state: the mount pipeline
runs the capability projection per mount rather than expecting it from a git
export.

## Standalone Variant

A single-member build uses the same generated root with the other members
absent: the member still mounts at `repos/<name>` under its canonical cell
name, and the platform labels are byte-identical. Proven at the action-digest
level: the member's real digest is identical across single-member, two-member,
renamed-root, and real-dotfiles-root shapes — the root cell's name and content
are irrelevant to member identity.

## Invariants Worth Restating

- The root cell's own name does not enter member action identity; member mount
  path, member cell name, platform label, and isolation dir do.
- A symlinked member mount is not a failure — it is a silent digest split
  (COMP-R10). Real directories are load-bearing, not stylistic.
- Presence of additional members or targets does not perturb an unrelated
  member's digests.
- Watchman is declared at the composition root and drives cross-cell
  invalidation; a member's own `file_watcher` setting is inert.
- Cross-cell `load()` of member-owned rules works; shared rules stay free of
  private facts (BUCK-R14).
