# Live pnpm Spec

This document specifies live pnpm materialization. It builds on
[requirements.md](./requirements.md).

Status: **Draft**

## Scope

This spec defines:

- live workspace topology authority;
- managed install ownership;
- mutable state boundaries for local development and CI;
- the live install relation to pure projection, root-owned state, shared
  content, and install evidence.

This spec does not define Nix prepared dependency artifacts. Those are specified
in [../03-nix-prepared-deps/spec.md](../03-nix-prepared-deps/spec.md).

## Requirement Trace

| Section           | Requirements                                           |
| ----------------- | ------------------------------------------------------ |
| Model             | DMP.LIVE-R01, DMP.LIVE-R08, DMP.LIVE-R11               |
| Install Ownership | DMP.LIVE-R01, DMP.LIVE-R02, DMP.LIVE-R03, DMP.LIVE-R04 |
| Runtime Identity  | DMP.LIVE-R05, DMP.LIVE-R06, DMP.LIVE-R07               |
| CI State          | DMP.LIVE-R10                                           |
| Health            | DMP.LIVE-R09, DMP.LIVE-R11                             |
| Mutation Parity   | DMP.LIVE-R12                                           |

## Model

```text
selected workspace topology
  -> managed pnpm install with strict policy
  -> dependency data in live node_modules
  -> pure projection repair
  -> install evidence and health report
```

The selected topology, not the current working directory, owns live install
state.

## Install Ownership

Managed install entrypoints must compute or receive:

- `ownerRoot`: the workspace root that owns the install;
- `topologyKind`: `standalone`, `composed`, or `packageClosure`;
- `lockfile`: the authoritative lockfile for that owner;
- `workspaceFile`: the workspace membership file for that owner;

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

## Mutation Parity

Every managed entrypoint that can mutate an authoritative lockfile or graph
uses the same realization transaction:

```text
Materialization-Root lock + package-manager-home lock
  -> selected fresh Store Cache namespace
  -> shared Store Cache admission lease
  -> capacity gate
  -> canonical policy arguments
  -> pnpm mutation
  -> root-local projection
```

Install, update, and deduplicate operations cannot select separate topology,
lifecycle, cache, or concurrency policies. Historical cache namespaces remain
outside the transaction and cannot block current materialization.

## Runtime Identity

The live model must preserve one runtime dependency graph for a selected
topology. When a composed workspace links local source across repo boundaries,
runtime entrypoints must preserve the logical topology paths required by the
runtime so linked packages resolve shared dependencies through the selected
graph.

Runtime identity is established by the selected standalone or composed
workspace topology. Sharing storage is not an identity primitive: every live
root owns `node_modules/.pnpm`, while mutually trusted roots may reuse one
pnpm-owned Store Cache.

### Dependency edge selection authority

pnpm owns dependency-edge selection and realization inside live `node_modules`
and the root-local virtual store. Managed repair discards that root-owned graph,
then asks the root's canonical pnpm install to select and materialize it again.
It does not sweep the host Store Cache and never selects or links a replacement
target itself.

Missing dependency edges are corrected at a declared authority boundary:

- the consuming package manifest for real runtime dependencies;
- pnpm `packageExtensions` for a declared package-manager compatibility
  extension;
- the generated workspace topology for local source membership.

This distinction is especially important for peer-dependent packages. Two
store entries with the same package name and version may still represent
different package-instance identities because of peer context, patches,
injected workspace copies, or platform selection. A filesystem repair that
ignores that identity can override a correct pnpm edge with an incompatible
dependency.

## CI State

CI jobs use a job-local pnpm home, Store Cache, virtual topology, and projection
state. The job remains the sole mutation owner for all of those paths.

## Health

A live Materialization Root is healthy only when:

1. the selected topology inputs match the generated install contract and
   cached state;
2. root-owned pnpm metadata exists;
3. dependency data is present;
4. expected pure projections exist.

Root health does not imply that a Store Cache contains every package
needed for a future offline reinstall. Offline readiness is a separate claim
that requires its own no-network evidence for the declared inputs.

Exit-code downgrades such as pnpm teardown exits are allowed only after these
checks prove materialization succeeded.
