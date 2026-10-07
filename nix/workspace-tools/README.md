# Workspace Tools (Nix)

Reusable Nix helpers for Buck product packaging, shared CLI build identity, and
live pnpm workspace policy. Buck owns product compilation; Nix acquires declared
dependency archives and imports or reconstructs the pinned Buck product graph.

## Layout

- `lib/`
  - `buck2-build-product-contract.nix` — pure exact validation and canonical
    identity for the shared Buck-to-Nix product descriptor.
  - `buck2-artifact-import.nix` — fail-closed product import entry point with
    runtime inspection delegated to the admitted runtime-specific inspectors.
  - `buck2-runtime-inspect-*.nix` — observation-only runtime verification.
  - `buck2-product-candidates.nix` — package candidates backed by Buck products.
  - `javascript-product-import.nix` — JavaScript module and runtime-tree import.
  - `mk-cli-packages.nix` — the retained Buck-backed CLI package wrapper.
  - Buck capability, archive, source-identity, and release helpers and tests.
  - `cli-build-stamp.nix` — shared build stamp helper for CLIs.
  - `pnpm-install-policy.nix` — strict live install policy and workspace-boundary
    handling.
  - `pnpm-source-input-specifiers.cjs` — importer-relative staged source-input
    `file:` specifier algebra.

## Flake Exports

From `effect-utils/flake.nix`:

```nix
lib.mkBuck2ArtifactImport
lib.mkBuck2JavaScriptProductImport
lib.mkCliPackages
lib.cliBuildStamp
```

Downstream package consumers should make their root `nixpkgs` and `flake-utils`
follow `effect-utils/nixpkgs` and `effect-utils/flake-utils` to share the canonical
build graph.

Run `bash nix/workspace-tools/lib/tests/downstream-flake-input.sh "$PWD"` to
exercise the retained public outputs from standalone and composed downstream
flake layouts. The test archives the committed `HEAD` source for both layouts,
so commit local source changes first. Live editor projections, daemon state,
and CI evidence are deliberately outside this consumer contract.

The Buck-to-Nix product contract is specified in
[`context/builds/05-product-distribution/02-nix-bridge`](../../context/builds/05-product-distribution/02-nix-bridge/spec.md).
`nix/buck2-products/pnpm-archives.nix` acquires immutable per-package archives;
it does not install a workspace dependency tree. Shared native dependency
classification and audits remain live independently of CLI packaging.

The former compiler/prepared-install packaging family is retired. There is no
workspace-install FOD hash registry, source-support package export, aggregate
manifest alignment passthrough, or prepared-tree restore API. Product consumers
use the Buck packaging boundary above; live workspaces continue to use the
strict pnpm task policy and source-input algebra below.

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
asserts the boundary by default; `ephemeral = true` creates a missing boundary
only for the wrapped install, without persisting that boundary into the root.

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
are treated alike when classifying staged source-input projections.
