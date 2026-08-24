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

| Section              | Requirements                                           |
| -------------------- | ------------------------------------------------------ |
| Model                | DMP.LIVE-R01, DMP.LIVE-R08, DMP.LIVE-R11               |
| Install Ownership    | DMP.LIVE-R01, DMP.LIVE-R02, DMP.LIVE-R03, DMP.LIVE-R04 |
| Source Input Staging | DMP.LIVE-R03, DMP.LIVE-R06, DMP.LIVE-R13, DMP.LIVE-R14 |
| Runtime Identity     | DMP.LIVE-R05, DMP.LIVE-R06, DMP.LIVE-R07               |
| CI State             | DMP.LIVE-R10                                           |
| Health               | DMP.LIVE-R09, DMP.LIVE-R11, DMP.LIVE-R14               |
| Mutation Parity      | DMP.LIVE-R12, DMP.LIVE-R14                             |

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

Nested roots are explicit but need not be active in the same topology:

```text
parent composed root
  owns parent lockfile, Source Input stage, and node_modules projection

repos/effect-utils
  remains canonical read-only source input to the parent topology
  owns its lockfile and node_modules only when selected as a standalone root
```

The parent consumes a published source generation from a nested root, but it
must not silently repair or mutate the nested root's dependency state.

## Source Input Staging

```text
canonical cross-repo Source Inputs (read-only)
  -> writable root-local generation construction
  -> validate complete identity and publish a read-only generation atomically
  -> generated pnpm overrides select the published generation
  -> pnpm realizes Package Instances and Dependency Edges
```

A composed topology declares the relative paths of canonical Source Inputs
owned by independently valid repository roots. The managed mutation transaction
copies that declared set into root-owned construction state before invoking
pnpm. It validates that canonical source did not change during the copy, makes
the completed generation read-only, then publishes it through one atomic
pointer switch. It does not discover or rewrite installed package occurrences
after pnpm runs.

The published generation preserves package-relative layout so generated
`file:` overrides can address stable paths. Staging rejects absolute paths,
parent traversal, missing sources, all directory symlinks, resolved file
symlink escapes, and cleanup or publication destinations outside its fixed
root-owned subtree.

The declared source set and canonical content determine one generation
identity. Readiness validates that the published read-only generation matches
that identity; staged output is not a second freshness authority. A canonical
change invalidates readiness until the next managed boundary publishes the
matching complete generation.

pnpm remains the Authoritative Materializer: the stage supplies Source Inputs
but neither creates Package Instances nor selects, removes, or retargets
Dependency Edges. Package Instances within one Materialization Root may reuse
published bytes. Separate Materialization Roots never share writable
construction state.

effect-utils owns the reusable staging, identity, validation, and containment
primitive. Readiness checks remain read-only: a miss schedules the managed
mutation transaction that publishes the next generation. A downstream root
only declares its Source Input paths and emits
topology overrides for the fixed published-generation location.

## Mutation Parity

Every managed entrypoint that can mutate an authoritative lockfile or graph
uses the same realization transaction:

```text
Materialization-Root lock + package-manager-home lock
  -> selected fresh Store Cache namespace
  -> shared Store Cache admission lease
  -> capacity gate
  -> atomic root-local Source Input generation publication
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
