# Dependency Materialization Spec

This document specifies effect-utils dependency materialization. It builds on
[requirements.md](./requirements.md).

Status: **Draft**

## Scope

This spec defines:

- the strict pnpm install policy;
- the separation between dependency data, executable projections, and native
  build outputs;
- the prepared dependency FOD purity boundary;
- the prepared dependency profile shape shared by Nix and Buck2 evidence;
- the repair, doctor, and benchmark gates for changing the policy.

This spec does not define package-specific native integrations. Those belong in
Nix package derivations, native package registries, or downstream wrappers that
name the package and platform explicitly.

Subsystem specs refine this root model:

```text
dependency-materialization/
  01-live-pnpm/              mutable worktree installs
  02-projections/            deterministic executable and metadata projection
  03-nix-prepared-deps/      immutable Nix prepared dependency artifacts
    01-fod-hash-evidence/   cross-system FOD hash evidence
    02-native-node-packages/ native package classification and grafting
  04-store-authority/        shared content, repair, prune, and GC authority
  05-buck2-evidence/         Buck2 evidence-only boundary
  06-observability/          producer facts and build-log bridge records
  07-verification/           proof, benchmark, and regression architecture
```

## Requirement Trace

| Section                                          | Requirements                                |
| ------------------------------------------------ | ------------------------------------------- |
| Model                                            | DMP-R09, DMP-R10, DMP-R11                   |
| Strict pnpm Install Policy                       | DMP-R01, DMP-R02, DMP-R03, DMP-R04          |
| Dependency Data, Projections, And Native Outputs | DMP-R05, DMP-R06, DMP-R08                   |
| Prepared FOD Purity                              | DMP-R05, DMP-R08, DMP-R18                   |
| Pure Bin Projection                              | DMP-R06, DMP-R07, DMP-R17                   |
| Prepared Profile Evidence                        | DMP-R09, DMP-R10                            |
| Storage Ownership And Authorities                | DMP-R12, DMP-R13, DMP-R14                   |
| Doctor And Repair                                | DMP-R15                                     |
| Benchmark And Acceptance Gates                   | DMP-R16, DMP-R17, DMP-R18, DMP-R19          |
| Verification Architecture                        | DMP-R16, DMP-R17, DMP-R18, DMP-R19, DMP-R20 |

## Model

```text
canonical workspace inputs
  -> pure pnpm materialization
     -> dependency data
     -> pure executable projection
     -> Nix/native wrapper integration
     -> prepared profile evidence and live health reports
```

pnpm is responsible for resolving and linking package contents. It is not the
authority for executing package lifecycle code in effect-utils-managed paths.

## Strict pnpm Install Policy

Managed live installs and prepared dependency builds use the strict install
policy:

```text
pnpm install
  --frozen-lockfile or --no-frozen-lockfile selected by caller
  --ignore-scripts
  --config.side-effects-cache=false
  --config.verify-store-integrity=true
  --config.strict-store-pkg-content-check=true
```

Prepared dependency builds additionally use `--no-optional` unless a profile
explicitly opts into a different optional-dependency policy.

Install entrypoints reject arguments or config that would re-enable lifecycle
execution:

| Surface                                                                          | Decision                                       |
| -------------------------------------------------------------------------------- | ---------------------------------------------- |
| `--no-ignore-scripts`, `--ignore-scripts=false`, `--config.ignore-scripts=false` | reject                                         |
| `pnpm rebuild` for managed dependency materialization                            | reject or route to explicit native integration |
| `pnpm approve-builds`, `--allow-build`, `dangerouslyAllowAllBuilds`              | reject                                         |
| `allowBuilds` / `onlyBuiltDependencies` as trust gate                            | not used for managed purity                    |

The generated pnpm workspace contract may still mention upstream pnpm fields
when needed for compatibility, but effect-utils-managed materialization treats
script execution as closed.

## Dependency Data, Projections, And Native Outputs

```text
dependency data       package files linked by pnpm without scripts
projection state      .bin links, wrappers, generated local metadata
native/build output   compiled .node files, downloaded runtimes, generated CLIs
```

Dependency data may be archived in prepared dependency artifacts when it is
deterministic and platform-classified. Projection state is recreated after
restore. Native/build output is excluded unless it is a pure package artifact
or a Nix-produced artifact explicitly named by the profile.

## Prepared FOD Purity

The prepared pnpm dependency FOD is a strict data artifact. After pnpm install
and normalization, validation scans the prepared tree before archive.

The default failing scan rejects:

- `node_modules/.bin` directories and their shims;
- pnpm store, home, state, cache, and lock metadata paths that are not part of
  the restored dependency graph;
- unexpected `*.node` files;
- known platform-specific package directories such as `@esbuild/*`,
  `@rollup/rollup-*`, `@tailwindcss/oxide-*`, `@cloudflare/workerd-*`, and
  `@opentui/core-*`, unless the profile classifies them as pure package data;
- leaked absolute pnpm store, home, cache, or workspace-local state paths.

Removing `.bin` changes recursive fixed-output hashes, so enabling this purity
scan requires a prepared artifact version bump and regenerated hashes. The
strict-scan transition is a single convergent boundary: bump the prepared
artifact version, enforce the failing scan immediately for that version, and
refresh the affected hashes rather than carrying report-only or profile-gated
legacy scan modes.

## Pure Bin Projection

Bin projection creates executable entries after dependency data exists.

```text
installed package manifests
  + package roots visible from each workspace package
  + platform shim policy
  -> node_modules/.bin entries
```

The projection step:

1. discovers package roots from the realized `node_modules` graph and pnpm
   projection metadata;
2. reads each package manifest's `bin` field;
3. validates that the target file exists in package data;
4. creates the expected shim or symlink in the relevant `node_modules/.bin`;
5. records a projection report for doctor and repair.

It must not import package code, run package scripts, call `pnpm rebuild`, or
invoke pnpm build approval commands.

Effect-utils owns the production bin projector. Pnpm's published linker is a
conformance oracle for compatible edge cases, not the runtime authority.

### Bin Projection Edge Cases

The projection contract covers:

- scoped package names;
- string and object `bin` fields;
- package aliases where the dependency name differs from the package name;
- package-local bins for workspace package roots;
- executable bit and shebang preservation on Unix;
- deterministic overwrite of stale shims owned by the Materialization Root.

The projection does not cover package CLIs generated by postinstall. Those are
native/build integration work.

## Prepared Profile Evidence

Nix prepared-dependency and Buck2 evidence retain the existing `profileKey`
compatibility boundary. It describes immutable dependency work and excludes
live storage placement and operational authority:

```json
{
  "kind": "dependency-materialization-profile",
  "schemaVersion": 1,
  "profileKey": "<sha256>",
  "identity": {
    "installDir": ".",
    "lockfilePath": "pnpm-lock.yaml",
    "memberDirs": ["packages/app"],
    "freshness": {},
    "policy": {
      "packageManager": "pnpm",
      "lockfileMode": "frozen",
      "lifecycleScripts": "ignored"
    }
  },
  "depsHash": "sha256-..."
}
```

Live pnpm roots do not emit a second profile artifact. Their generated install
contract plus install and projection hashes are the evidence used to decide
whether installation is current.

Nix prepared-deps producers also expose `fodHashRepairTargets` as evaluated
package metadata. Each target derives from the same profile and `depsBuilds`
hash declaration as the fixed-output derivation. Repair tools consume those
targets to rebuild direct dependency artifacts and publish run evidence; package
sources do not carry a second per-target witness file.

## Storage Ownership And Authorities

| State                                     | Scope                         | Mutation authority       |
| ----------------------------------------- | ----------------------------- | ------------------------ |
| live dependency graph and virtual store   | one Materialization Root      | that root's pnpm install |
| live executable projection                | one Materialization Root      | pure projection task     |
| pnpm Store Cache                          | host-local or CI-job-local    | pnpm concurrency control |
| prepared dependency data                  | immutable Nix store output    | Nix build                |

The local-development Store Cache is shared only across mutually trusted roots
owned by the same user. effect-utils exposes no Materialization-Root repair or
prune operation that sweeps that host cache. Nix prepared-dependency production
remains an independent immutable path and does not consume the live host cache.

## Doctor And Repair

Doctor checks:

- the install contract and cached state match the current topology and policy;
- dependency data is present;
- dependency data referenced by the current graph is present;
- prepared artifact scans pass for the selected inputs;
- expected `.bin` projection entries exist and point at package data;
- no lifecycle sentinel output exists in verification fixtures.

Repair may:

- rerun pure pnpm install with scripts disabled;
- recreate `.bin` projection;
- restore prepared data from Nix;

Repair may not:

- run dependency lifecycle scripts;
- run pnpm rebuild;
- approve package builds;
- compile or download native outputs through package-manager hooks.

## Benchmark And Acceptance Gates

A materialization policy change is accepted only when it proves:

- no lifecycle sentinel scripts ran;
- expected bins exist after projection in a faithful fixture;
- at least one real downstream graph with missing bins is repaired;
- prepared dependency FOD scans reject `.bin`, unexpected native files, and
  leaked pnpm state;
- fixed-output hashes are measured per covered system, with missing systems
  marked pending rather than silently collapsed;
- host-wide bytes, file counts, cold install, warm install, and concurrent
  install are recorded; offline reinstall and repair timing are required only
  when those capabilities are explicitly claimed.

The [verification subsystem](./07-verification/spec.md) owns the evidence
matrix, proof tiers, benchmark record shape, and regression-gate routing for
these acceptance gates.

## Open Design Questions

No open design questions remain for this milestone.
