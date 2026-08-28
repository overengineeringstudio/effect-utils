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
  workspace = .                        # the synthesized shell; declares no targets
  prelude = prelude
  toolchains = toolchains
  none = none
  <member-cell> = repos/<member>       # one line per member incl. the owned repo
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
  target_platform_detector_spec = target:<member-cell>//...-><hub>//buck2/platforms:host_platform
                                  # one clause per member cell, every cell covered
[build]
  execution_platforms = <hub>//buck2/platforms:host_execution_platform
```

The workspace cell is a pure synthesized shell (decision 0020 abolished the
root-repo-at-`.` special case): every repository, including the one under
development, is a member cell at `repos/<name>`.

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

## Workspace Anatomy

Per [decision 0020](../.decisions/0020-one-writable-mount-workspaces.md), the
workspace root sits at the store worktree path (policy-compatible with the
fleet worktree-placement and search-depth guards, and the layout under which
store GC and hygiene rules keep working):

```text
~/.megarepo/github.com/<owner>/<repo>/refs/heads/<branch>/   # workspace root
  .buckconfig .buckroot BUCK toolchains/ none/ buck-out/
  repos/<repo>/            # THE writable branch-attached worktree (owned)
  repos/<other-member>/    # read-only cp -a mounts at locked revs
  repos/.staging-<member>/ # transient RENAME_EXCHANGE staging
```

Member mounts carry tracked sources plus a dist overlay — the member's
Buck2-built dist artifacts at the locked revision, pulled from the shared
cache (built locally on miss), declared per member by a genie-projected dist
manifest, and kept out of action digests by the root's `[project] ignore`
([decision 0021](../.decisions/0021-cross-member-types-dist-overlay.md)).
This is what gives editors and typecheck actions cross-member types through
the unchanged `exports` types→dist mechanism.

The workspace root is not a git repository; the owned member is, and it is
the default working directory (git, devenv, genie, and pnpm all operate from
the member; nothing operates only from the root). `buck2 build` works from
the root, the member, and package dirs alike (COMP-R06); note `buck2 root`
defaults to `--kind cell` (the member) — scripts wanting the workspace pass
`--kind project`. Teardown is an mr operation (protected mounts need a
dirs-only unprotect before removal), never a bare `rm -rf`.

## Agent Workflow Contract — Revision 3

```text
branchy/mr owns <workspace>/
                    |
                    +-- repos/<owned>/   edit, commit, run repo tools
                    +-- repos/<other>/   read-only build input
                    +-- repos/<ignored>/ reference only; outside Buck
```

The workspace root is orchestration state, not an authoring checkout. Agents
follow these rules:

1. Start and resume work through the store-backed workspace; do not create an
   independent checkout outside the store.
2. Use `repos/<owned>` as the default cwd and the only source tree mutated by
   the session.
3. Run git, devenv, Genie, pnpm, and package-local commands from the owned
   member. A command that needs the composition root resolves it through mr or
   `buck2 root --kind project`; it does not infer `../..` in application code.
4. Treat every non-owned `repos/<member>` as immutable input. Never edit,
   chmod, replace, branch, or run a producer that writes there.
5. Treat ignored members as reference-only. They are excluded from Buck cells,
   capability projection, overlays, and mutation-driven composition work.
6. To change another member, create or resume that repository's own
   store-backed branch workspace, commit there, then advance the consumer's
   lock and re-apply composition. Cross-member work is commit-mediated and
   upstream-first.
7. Run Buck from the root, owned member, or a package directory using canonical
   member labels. Scripts that need project identity use the project root, not
   the current cell root.
8. Use mr for apply, advance, recovery, status, and teardown. Never replace
   protected-mount teardown with `rm -rf` or an in-place copy.
9. CI creates a job-owned store branch with an explicit worktree mode,
   synthesizes composition before credentials, runs source-dependent commands
   from the owned member, and always invokes guarded teardown.
10. A dirty non-owned mount, a foreign real path, a missing ownership manifest,
    or an R6 mismatch is a hard stop. Do not repair around the guard.
11. Handoffs name both the workspace root and owned-member cwd, plus any
    upstream commit whose lock advance is still pending.
12. Shared-cache evidence is admissible only from content-real mounts; legacy
    symlink compositions remain outside the shared cache namespace.

## Standalone Variant

A single-member build is simply a workspace with no other members mounted:
the owned repo still lives at `repos/<name>` under its canonical cell name,
and the platform labels are byte-identical. Proven at the action-digest
level: digests are identical across single-member, two-member, renamed-root,
and real-dotfiles-root shapes, and between a writable branch worktree and a
read-only mount at the same commit — the root cell's name, the root's
absolute path, and the mount's write bit are all irrelevant to member
identity.

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
