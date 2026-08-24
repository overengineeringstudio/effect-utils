# Nix Prepared Dependencies Spec

This document specifies Nix prepared dependency artifacts. It builds on
[requirements.md](./requirements.md).

Status: **Draft**

## Scope

This spec defines:

- staged dependency inputs;
- strict prepared dependency installation;
- normalization and purity scanning;
- downstream restore;
- the relation to native package integrations, FOD hash evidence, and
  observability.

## Requirement Trace

| Section                       | Requirements                                       |
| ----------------------------- | -------------------------------------------------- |
| Pipeline                      | DMP.NIX-R01, DMP.NIX-R04, DMP.NIX-R05, DMP.NIX-R07 |
| Staged Inputs                 | DMP.NIX-R02, DMP.NIX-R06, DMP.NIX-R12, DMP.NIX-R13 |
| Install Policy                | DMP.NIX-R01                                        |
| Optional Binding Opt-In       | DMP.NIX-R11                                        |
| Normalization And Purity Scan | DMP.NIX-R03, DMP.NIX-R04                           |
| Restore                       | DMP.NIX-R05, DMP.NIX-R07, DMP.NIX-R13              |
| Evidence                      | DMP.NIX-R08, DMP.NIX-R09, DMP.NIX-R10              |

## Pipeline

```text
canonical topology inputs
  -> staged dependency inputs per install root
  -> pnpm install --frozen-lockfile --ignore-scripts
  -> normalize data artifact
  -> purity scan
  -> fixed-output prepared deps
  -> downstream restore
  -> pure projection + build
```

## Staged Inputs

```text
canonical lock + workspace policy
  + generated Source Input path contract
  + immutable filtered logical sources
  -> transient staged-path aliases to logical manifests
  -> frozen dependency preparation
  -> canonicalized injected and ordinary file links
  -> transient-alias removal
```

The staged workspace contains only dependency-relevant inputs:

- authoritative lockfile;
- relevant `package.json` manifests;
- workspace membership;
- patches and package-manager configuration;
- profile policy inputs.

Source-only edits outside this boundary must not invalidate the prepared
dependency artifact.

When canonical live topology uses root-local Source Input generation locators,
the Nix source-staging derivation creates transient alias directories at those
staged paths. Each alias contains only a `package.json` symlink to the
corresponding logical manifest already in the filtered snapshot, so source
descendants are not reachable through the compatibility tree. The mapping
comes only from the generated install
contract's `workspaceManifestContract.sourceInputStagePath` and
`workspaceManifestContract.sourceInputPaths`. The stage root must be exactly
`.devenv/pnpm-source-inputs/current`, matching cleanup authority, and only
declared paths with a present logical `package.json` receive an alias.

The frozen lockfile and workspace policy remain byte-consistent, including raw
`directory:` resolutions and `packageExtensionsChecksum`. After pnpm resolves
them, prepared-workspace normalization relinks local packages to the validated
real logical directory rather than the transient alias:

- injected packages use pnpm's `injectedDeps` locator mapping;
- ordinary `file:` packages use pnpm's `.package-map.json`
  locator-to-target mapping, which retains the exact peer-context variant.

Both paths consume pnpm's selected locator identity. Package-name or virtual
directory scans are not selectors. For an ordinary `file:` target, this relink
is required because pnpm accepts the manifest-only alias for frozen resolution
but materializes no package source bytes from it. `.devenv` is then removed,
and the prepared output must contain neither alias state nor broken references.
This compatibility bridge does not run the live Source Input publisher, copy
its generations, or add source-only files to manifest freshness.

## Install Policy

Prepared dependency preparation runs pnpm with:

```text
pnpm install --frozen-lockfile --ignore-scripts --no-optional
```

and with package-manager self-management, side-effects cache, and undeclared
host state disabled. Optional dependencies may be included only through an
explicit profile policy.

## Optional Binding Opt-In

Traces: DMP.NIX-R11.

The strict install policy runs `pnpm install --frozen-lockfile --ignore-scripts`
with optional dependencies stripped by default, so a prepared artifact carries
no platform native bindings. An install root may opt in to carrying its optional
native binding families:

- The opt-in is a per-install-root field on the prepared-deps entry (default
  off), threaded into every prepared-deps install site (root and external
  install roots) — not a global switch (would bloat every consumer's artifact)
  and not a separate binding-only FOD (over-engineered; see `0008`).
- When set, the install materializes optional dependencies under
  `supportedArchitectures` so pnpm resolves every declared `(os, cpu, libc)`
  triple into the captured `.pnpm` tree, and the completeness assertion
  (`02-native-node-packages`, `DMP.NIX.NATIVE-R08`) gates the result.
- Bindings resolve from a family's own isolated `.pnpm/<pkg>/node_modules/…`
  subtree; the top-level `node_modules/<scope>` stays empty. The opt-in FOD is
  therefore the sanctioned channel for `pure-package-artifact` families, distinct
  from the `nativeNodePackages` top-level graft used for `nix-grafted` families.
- The resulting hash change is a lockfile-scope change to that root and is
  repaired through the existing FOD hash-repair-target contract (`0005`), which
  already exposes the direct prepared-deps derivation as evaluated metadata —
  including for a nested-flake consumer boundary. No new repair surface is
  introduced by this opt-in.

## Normalization And Purity Scan

The prepared output is a directory-shaped dependency data tree. The scan fails
by default on:

- `node_modules/.bin`;
- pnpm home, cache, store, and state paths not needed by downstream restore;
- leaked absolute build or workspace paths;
- unexpected `*.node` files;
- known platform package directories unless explicitly classified.

The strict scan transition is versioned at the prepared artifact boundary. The
next tightening that strips and rejects archived `.bin` projection state uses
prepared artifact version `v18`, enforces the scan immediately for `v18`, and
requires regenerated fixed-output hashes for all affected prepared dependency
artifacts.

The output hash is the recursive directory hash of the normalized data tree.
Archive streams may be used for transport, but archive bytes are not the
fixed-output contract.

## Restore

Downstream builds restore prepared data into the staged source build workspace.
They then run pure projections, graft explicit native integrations, and build
the final package.

The full logical source snapshot is present before prepared dependency data is
overlaid. Relinked injected and ordinary local-file package targets therefore
resolve through the same logical source directories after overlay. The focused
`prepared-workspace-source-input-file-links` regression covers an ordinary
locator with several adjacent peer-context groups, verifies the exact
package-map target is relinked, removes the transient alias, and still resolves
package source bytes.

Downstream restore must not use pnpm to reconstruct dependency state.

## Evidence

Each prepared dependency artifact emits:

- dependency materialization profile evidence;
- prepared artifact version and policy digest;
- purity-scan result;
- covered system hash metadata;
- producer log facts for staging, preparation, normalization, scan, and
  restore.
