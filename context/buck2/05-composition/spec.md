# Composition Spec

This document specifies the normative standalone repository root and the
explicitly requested composed root retained during its paused retirement
window. It builds on [requirements.md](./requirements.md). The composed shape
is validated against the real repositories
([.experiments/2026-08-26-composition-root-real-repos.md](./.experiments/2026-08-26-composition-root-real-repos.md)).

## Status

Draft.

## Scope

**Defines:** the composition root shape, its generator, and the standalone
variant.

**Does not define:** member semantics (01), platforms (02), or cache wiring
(04).

## Paused Composition Root Shape

An explicitly requested cross-repository composition uses the mr-generated
root `.buckconfig` below:

```ini
[cells]
  workspace = .                        # the synthesized shell
  prelude = prelude
  capabilities = .buck2/capabilities  # root-owned, Nix-produced projection
  <member-cell> = repos/<member>       # one line per member incl. the owned repo
[cell_aliases]
  config = prelude
  ovr_config = prelude
  fbsource = prelude
  toolchains = <hub>
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

The root carries no synthetic toolchains or `none` cell. Prelude's conventional
`toolchains//` spelling is a compatibility alias to the live hub cell; the hub's
real `buck2/toolchains` package owns the exact host capability providers. The
detector spec lists every cell explicitly (COMP-R04). The hub cell for platforms
is effect-utils; its real package is `buck2/platforms` with `host_platform` /
`host_execution_platform` targets (COMP-R05).

Because `[cell_aliases] toolchains = <hub>` makes `toolchains//:<name>` resolve
to `<hub>//:<name>`, the conventional targets prelude looks up live in the hub's
**root package**, each a native `toolchain_alias` onto the real
`<hub>//buck2/toolchains:<name>` target (`alias` cannot front an
`is_toolchain_rule = True` target; `toolchain_alias` is itself a toolchain
rule). `genrule` is the one exception: `GenruleToolchainInfo` carries only
`zip_scrubber = None`, so the hub instantiates prelude's own
`system_genrule_toolchain` and pins nothing. Every prelude rule a member uses —
including prelude's internal Rust tools, which are `python_bootstrap_binary`
targets — therefore finds exactly one instance of each conventional toolchain,
and it is the hub's capability-backed one.

The bootstrap interpreter those prelude tools need is admitted in exactly one
realization — the hermetic, Nix-realized `python_bootstrap` toolchain of
[decision 0028](../.decisions/0028-hermetic-python-bootstrap-for-consumer-cells.md).
Ambient interpreters and CPython build edges stay refused, mechanically, by
`nix/devenv-modules/tasks/shared/tests/buck2-no-python-actions.test.sh`.

**Never emit `root = <root-repo>` in `[cell_aliases]`:** root-declared aliases
are visible in every cell, so the alias silently retargets a member's `root//`
references to the composition root. Without it the same reference is a loud
parse error naming the missing cell — the correct failure. Members are
therefore written cell-portable: no `root//` labels, no bare `toolchains//:`
labels (member-local labels instead).

## Generator

The generator is an mr library generator (beside the vscode and nix-lock
generators), consuming per composition: the member set with resolved mount
paths, the platform-hub member, and the isolation dir; and per member (from a
genie-projected member manifest read out of the mount): canonical cell name,
canonical mount path, `[project] ignore` contributions (rewritten root-relative
and unioned), executable capabilities, and toolchain requirements.

Toolchain instances and their Nix pins have one authority: the platform hub.
The hub manifest declares each available `ToolchainAuthority`; a consumer that
uses one declares the corresponding `ToolchainRequirement`. A consumer cannot
name an instance, package, executable, or pin in that requirement. An authority
carries a total `provides` list of the Nix-realizable executables that
constitute the kind, because kinds and executables have different arities: a
kind may be realized by several tool ids (`tsgo` → `effect-tsgo`), by one whose
id differs from the kind, or by none at all (`pnpm`, a developer-time pin with
no Buck rule behind it, declares `provides: []`). Kind names and provided tool
ids share one namespace: a provided tool id may not collide with a member-owned
capability or with another authority's. Composition resolves every requirement
to the hub before generating or publishing root bytes and refuses an unknown
requirement, duplicate authority or requirement, non-hub authority, or a
member-owned executable capability that attempts to override the required
toolchain _or any tool id an authority provides_. This is an explicit
shared-pin contract, not silent inheritance.

`--isolation-dir` is CLI-only and cannot be pinned by buckconfig, so mr owns
the invocation wrapper that fixes the paused composed shape to its isolation
dir (COMP-R07). Standalone invocations use their own fixed isolation identity;
action-key parity between the two shapes is not promised.

Ordinary development and single-repository CI use standalone Buck project
roots. Their tracked `.buckconfig` declares the member cell at `.`, the bundled
Prelude, and the root-owned `capabilities//` cell. The devenv shell links the
pure `packages.<system>.buck2-capabilities` output at
`.buck2/capabilities`; no projector runs during shell entry.

The same Nix output is the only capability projection used by composition.
`mr apply` treats the member manifest as data, verifies the projection's exact
BUCK and `defs.bzl` bytes, platform, tool and executable identities, closure
paths, and generation, then atomically links the output at the composition
root's `.buck2/capabilities`. A member-shipped projector remains inert data.
Hub toolchains address the projection through `capabilities//`, so read-only
member mounts do not carry or mutate a projection.

## Paused Composed Workspace Anatomy

For an explicitly requested cross-repository composition, the workspace root
sits at the store worktree path per
[decision 0020](../.decisions/0020-one-writable-mount-workspaces.md)
(policy-compatible with the fleet worktree-placement and search-depth guards,
and the layout under which store GC and hygiene rules keep working):

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

The composed workspace root is not a git repository; the owned member is, and
it is the default working directory for explicit composition operations. Buck
can run from the root, owned member, or a package directory (COMP-R06);
scripts that need the composed project root pass `buck2 root --kind project`.
Teardown is an mr operation (protected mounts need a dirs-only unprotect before
removal), never a bare `rm -rf`.

## Composed-Exception Agent Workflow Contract — Revision 3

This contract applies only when a cross-repository composition is explicitly
requested during the paused retirement window:

```text
branchy/mr owns <workspace>/
                    |
                    +-- repos/<owned>/   edit, commit, run repo tools
                    +-- repos/<other>/   read-only build input
                    +-- repos/<ignored>/ reference only; outside Buck
```

The workspace root is orchestration state, not an authoring checkout. In this
exceptional shape, agents follow these rules:

1. Start and resume the composition through its store-backed workspace; do not
   create an independent composed checkout outside the store.
2. Use `repos/<owned>` as the default cwd and the only source tree mutated by
   the session.
3. Run git, Genie, pnpm, and package-local commands from the owned member.
   Resolve a composition root through mr or `buck2 root --kind project` only
   for an explicit composition operation; do not infer `../..` in application code.
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
9. Effect-utils CI runs from the actions checkout as its tracked standalone
   Buck root. The paused composed shape is a development-only exception until
   L3 cut 2 and is never synthesized as CI setup.
10. A dirty non-owned mount, a foreign real path, a missing ownership manifest,
    or an R6 mismatch is a hard stop. Do not repair around the guard.
11. Handoffs name both the workspace root and owned-member cwd, plus any
    upstream commit whose lock advance is still pending.
12. Shared-cache evidence is admissible only from content-real mounts; legacy
    symlink compositions remain outside the shared cache namespace.

## Standalone Variant

A standalone repository is the normative Buck project root for ordinary
development and single-repository CI. Its tracked `.buckconfig` maps the
canonical member cell name to `.`, declares the same platform labels and
Nix-produced capability cell, and its tracked `.buckroot` prevents accidental
discovery of an outer project. Effect-utils CI and devenv Buck tasks use this
shape directly; a second standalone checkout at the same revision is the
BUCK-R06 cache-reuse comparison context.

`devenv tasks run check:quick` and `check:all` execute their Buck aggregates,
lint actions, test actions, and editor-view publication from this root. The
check graph does not run `mr:setup`, `mr:apply`, or any `mr:*` validation gate.
Repository composition remains an explicit mr operation outside the check
surface.

The paused composed shape remains distinct until L3 cut 2: the member is
mounted at `repos/<name>` under the same canonical cell name. Action-digest
parity between these two shapes must be measured rather than assumed; the
standalone CI cutover does not weaken the same-shape, cross-checkout BUCK-R06
zero-reexecution requirement.

## Invariants Worth Restating

- The root cell's own name does not enter member action identity; member mount
  path, member cell name, platform label, and isolation dir do.
- A symlinked member mount is not a digest split: Buck2 hashes the target path
  string but not the member content behind it. Edits therefore do not
  invalidate actions, and one key can serve stale artifacts (COMP-R10).
  Shared-cache writes are forbidden for this shape; real directories are
  load-bearing, not stylistic.
- Presence of additional members or targets does not perturb an unrelated
  member's digests.
- Watchman is declared at the composition root and drives cross-cell
  invalidation; a member's own `file_watcher` setting is inert.
- Cross-cell `load()` of member-owned rules works; shared rules stay free of
  private facts (BUCK-R14).
