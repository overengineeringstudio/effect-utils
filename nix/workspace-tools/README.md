# Workspace Tools (Nix)

Reusable Nix helpers for Buck products, pnpm-based workspace CLIs, and shared
CLI utilities. These are pure and designed to work in both megarepo workspaces
and standalone repos.

## Layout

- `lib/`
  - `buck2-build-product-contract.nix` — pure exact validation and canonical
    identity for the shared Buck-to-Nix product descriptor.
  - `buck2-artifact-import.nix` — fail-closed product import entry point; the
    exact `elf-dynamic/v1` inspector is admitted and other runtimes remain
    rejected until their inspectors exist.
  - `buck2-runtime-inspect-elf-dynamic.nix` — observation-only ELF class,
    machine, interpreter, dependency, and runtime-path verification.
  - `mk-pnpm-cli.nix` — pnpm + bun compile builder for workspace CLIs.
  - `mk-pnpm-deps.nix` — FOD helper for preparing relocatable pnpm install trees that downstream builds restore without rerunning `pnpm install`.
  - `cli-build-stamp.nix` — build stamp helper for CLIs.
  - `pnpm-install-policy.nix` — install knobs shared by live and prepared
    installs, plus the workspace-boundary rule below.
  - `pnpm-source-input-specifiers.cjs` — the staged source-input `file:`
    specifier algebra shared by every surface that writes, classifies, or
    strips one.

## Flake Exports

From `effect-utils/flake.nix`:

```nix
lib.cliBuildStamp
```

When a downstream repo consumes `effect-utils` packages or pnpm-based builders,
its root `nixpkgs` and `flake-utils` should follow `effect-utils/nixpkgs` and
`effect-utils/flake-utils`. That keeps prepared pnpm trees content-addressed
against one canonical build graph across standalone and composed views.

For `mk-pnpm-cli`, the core contract mirrors the layered derivation graph:

```nix
depsBuilds = {
  "." = { hash = "sha256-..."; };
  "repos/effect-utils" = { hash = "sha256-..."; };
};
```

- single-root CLIs use one `"."` entry
- composed CLIs use one entry per authoritative install root

Each `hash` is the authoritative fixed-output hash of one prepared deps
artifact. The downstream CLI derivation depends on those artifacts directly, so
the artifact hash already is the effective dependency fingerprint for rebuilds.
Any faster preflight staleness check belongs in tooling, not in the builder API.

Prepared pnpm dependency artifacts intentionally skip lifecycle scripts. Native
Node packages that require install/build scripts belong in the Nix package or
build phase that actually needs them, usually via `nativeBuildInputs`, PATH,
`nativeNodePackages`, or an explicit wrapper. `nativeNodePackages` links a
Nix-owned Node package into the restored build workspace for packages that still
resolve a native binding by npm name. Prebuilt optional native packages from the
lockfile, such as Rollup/Rolldown/Vite toolchain bindings, are acceptable only
as locked fixed-output pnpm inputs; they must not require a lifecycle build to
materialize.

The helper exposes the resulting install-root metadata via
`passthru.installRoots`, `passthru.depsBuildsByInstallRoot`, and
`passthru.depsBuildEntries` so downstream hash-refresh tooling can target the
real prepared dependency boundary for each root. Each `depsBuildEntries`
element also includes the install-root `drvPath` and dependency freshness
digests, which lets CI/tooling evict or realize the authoritative prepared-deps
derivation without guessing from derivation names.

`passthru.dependencyMaterializationEvidence` is the Nix-prepared dependency
contract. Its profile keys include staged manifest digests and inherited root
patch authority, so shared external install-root FODs converge for
byte-identical dependency inputs but move when lockfiles, package manifests, or
patch authority change. `passthru.buck2DependencyMaterializationEvidence`
adapts the same evidence into a Buck2-facing shape while explicitly declaring
that Buck2 does not own live pnpm materialization or repair.

## Two pnpm invariants every install root depends on

Both are properties of pnpm itself, both were silent under pnpm 11, and both
are load-bearing for composed workspaces. They are encoded once and asserted by
`nix/devenv-modules/tasks/shared/tests/pnpm-nested-roots-and-source-inputs.test.sh`.

### An install root must be a workspace boundary

pnpm discovers the workspace by walking **up** from the install root. A nested
root without its own `pnpm-workspace.yaml` is adopted by the nearest ancestor
workspace: the ancestor's lockfile is written instead of the nested one, the
ancestor's `overrides` apply, and the nested root's `node_modules` never
appears — after which a frozen install fails with `ERR_PNPM_NO_LOCKFILE`.
`--ignore-workspace` and a `cd`/`--dir` into the root do not prevent this.

`pnpmInstallPolicy.nestedWorkspaceBoundaryShell` is the one encoding. It
asserts the boundary by default (a staged root that lacks one is a builder
bug), and `ephemeral = true` declares a missing boundary only for the wrapped
install, for a root whose directory is itself a build artifact whose hash must
not move.

### A `file:` specifier is relative to the manifest that declares it

Staged source inputs live at `.devenv/pnpm-source-inputs/current/<sourcePath>`
and are reached through `file:` specifiers. pnpm resolves such a specifier
relative to the **declaring** manifest and records that importer-relative form
in `importers.<path>.dependencies.<name>.specifier`. So the root-relative
spelling is correct only for the root importer; for an importer at depth N it
does not resolve, and it disagrees with the lockfile, which a frozen install
rejects.

`pnpm-source-input-specifiers.cjs` owns this algebra:
`sourceInputSpecifierFor` gives the specifier an importer must declare,
`relativizeSourceInputSpecifier` re-spells an existing one for its importer,
and `targetsSourceInputStage` classifies a recorded value by resolved target so
that the root-relative and importer-relative spellings of the same dependency
are treated alike — which is what lets the projection be stripped from a
prepared tree completely.
