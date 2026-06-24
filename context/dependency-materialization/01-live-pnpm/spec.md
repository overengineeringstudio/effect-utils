# Live pnpm Spec

This document specifies live pnpm materialization. It builds on
[requirements.md](./requirements.md).

Status: **Draft**

## Scope

This spec defines:

- live workspace topology authority;
- managed install ownership;
- mutable state boundaries for local development and CI;
- the live install relation to pure projection, store traits, and profile
  evidence.

This spec does not define Nix prepared dependency artifacts. Those are specified
in [../03-nix-prepared-deps/spec.md](../03-nix-prepared-deps/spec.md).

## Requirement Trace

| Section | Requirements |
| --- | --- |
| Model | DMP.LIVE-R01, DMP.LIVE-R08, DMP.LIVE-R11 |
| Install Ownership | DMP.LIVE-R01, DMP.LIVE-R02, DMP.LIVE-R03, DMP.LIVE-R04 |
| Runtime Identity | DMP.LIVE-R05, DMP.LIVE-R06, DMP.LIVE-R07 |
| CI State | DMP.LIVE-R10 |
| Health | DMP.LIVE-R09, DMP.LIVE-R11 |

## Model

```text
selected workspace topology
  -> managed pnpm install with strict policy
  -> dependency data in live node_modules
  -> pure projection repair
  -> profile evidence and health report
```

The selected topology, not the current working directory, owns live install
state.

## Install Ownership

Managed install entrypoints must compute or receive:

- `ownerRoot`: the workspace root that owns the install;
- `topologyKind`: `standalone`, `composed`, or `packageClosure`;
- `lockfile`: the authoritative lockfile for that owner;
- `workspaceFile`: the workspace membership file for that owner;
- `profileId`: the dependency materialization profile id.

Package-directory installs are not supported when they would create
package-local lockfiles, package-local `node_modules`, or a second dependency
authority.

Nested roots are explicit:

```text
parent composed root
  owns parent lockfile and parent node_modules projection

repos/effect-utils
  owns nested lockfile and nested node_modules projection
```

The parent may link source from a nested root, but it must not silently repair
or mutate the nested root's dependency state.

## Runtime Identity

The live model must preserve one runtime dependency graph for a selected
topology. When a composed workspace links local source across repo boundaries,
runtime entrypoints must preserve the logical topology paths required by the
runtime so linked packages resolve shared dependencies through the selected
graph.

The implementation may use pnpm GVS, hoisting, or future store traits as the
path-collapsing primitive, but the profile must declare that trait and the
doctor must validate it.

## CI State

CI jobs use job-local writable pnpm home, store metadata, and projection state
by default. A shared cache may seed content, but the job remains the mutation
owner unless a stronger shared-state profile has explicit GC and repair
authority.

## Health

A live profile is healthy only when:

1. the selected topology inputs match the profile evidence;
2. pnpm metadata exists for the declared store trait;
3. dependency data is present;
4. expected pure projections exist;
5. offline or no-network usability checks pass for the selected profile when
   the store trait promises offline reuse.

Exit-code downgrades such as pnpm teardown exits are allowed only after these
checks prove materialization succeeded.
