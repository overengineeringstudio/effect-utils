# Workspace Tools (Nix)

Reusable Nix helpers for building Bun CLIs and shared CLI utilities. These are
pure and designed to work in both megarepo workspaces and standalone repos.

## Layout

- `lib/`
  - `buck2-build-product-contract.nix` — pure exact validation and canonical
    identity for the shared Buck-to-Nix product descriptor.
  - `buck2-artifact-import.nix` — fail-closed product import entry point; the
    exact `elf-dynamic/v1` inspector is admitted and other runtimes remain
    rejected until their inspectors exist.
  - `buck2-runtime-inspect-elf-dynamic.nix` — observation-only ELF class,
    machine, interpreter, dependency, and runtime-path verification.
  - `mk-bun-cli.nix` — Bun binary builder (deterministic, local file deps).
  - `mk-pnpm-cli.nix` — pnpm + bun compile builder for workspace CLIs.
  - `mk-pnpm-deps.nix` — FOD helper for preparing relocatable pnpm install trees that downstream builds restore without rerunning `pnpm install`.
  - `cli-build-stamp.nix` — build stamp helper for CLIs.
  - `update-bun-hashes.nix` — helper to refresh bunDeps hashes.
- `docs/`
  - `README.md` — index to mk-bun-cli notes.

## Flake Exports

From `effect-utils/flake.nix`:

```nix
lib.mkBunCli
lib.cliBuildStamp
apps.update-bun-hashes
```

## Quick Usage

Build a Bun CLI:

```nix
mkBunCli = import "${effect-utils}/nix/workspace-tools/lib/mk-bun-cli.nix" {
  inherit pkgs;
};
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
