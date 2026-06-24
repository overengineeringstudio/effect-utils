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
| Staged Inputs                 | DMP.NIX-R02, DMP.NIX-R06                           |
| Install Policy                | DMP.NIX-R01                                        |
| Normalization And Purity Scan | DMP.NIX-R03, DMP.NIX-R04                           |
| Restore                       | DMP.NIX-R05, DMP.NIX-R07                           |
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

The staged workspace contains only dependency-relevant inputs:

- authoritative lockfile;
- relevant `package.json` manifests;
- workspace membership;
- patches and package-manager configuration;
- profile policy inputs.

Source-only edits outside this boundary must not invalidate the prepared
dependency artifact.

## Install Policy

Prepared dependency preparation runs pnpm with:

```text
pnpm install --frozen-lockfile --ignore-scripts --no-optional
```

and with package-manager self-management, side-effects cache, and undeclared
host state disabled. Optional dependencies may be included only through an
explicit profile policy.

## Normalization And Purity Scan

The prepared output is a directory-shaped dependency data tree. The scan fails
by default on:

- `node_modules/.bin`;
- pnpm home, cache, store, and state paths not needed by downstream restore;
- leaked absolute build or workspace paths;
- unexpected `*.node` files;
- known platform package directories unless explicitly classified.

The output hash is the recursive directory hash of the normalized data tree.
Archive streams may be used for transport, but archive bytes are not the
fixed-output contract.

## Restore

Downstream builds restore prepared data into the staged source build workspace.
They then run pure projections, graft explicit native integrations, and build
the final package.

Downstream restore must not use pnpm to reconstruct dependency state.

## Evidence

Each prepared dependency artifact emits:

- dependency materialization profile evidence;
- prepared artifact version and policy digest;
- purity-scan result;
- covered system hash metadata;
- producer log facts for staging, preparation, normalization, scan, and
  restore.
