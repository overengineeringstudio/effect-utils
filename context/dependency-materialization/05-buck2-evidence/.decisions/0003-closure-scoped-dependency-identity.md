# 0003 Closure Scoped Dependency Identity

Status: accepted

## Context

Fine-grained Buck targets cannot achieve precise caching when they all consume
one workspace-wide dependency digest. The current Nix prepared dependency
builder produces normalized immutable install-root trees, but its own design
records that these trees are specific and reuse less broadly than shared
package data. The ambient live pnpm projection is already rejected for
authority after a declared source edit produced a stale Buck daemon cache hit.

## Evidence and Argument

- The user selected the exact-closure option in q3 and set the optimization
  principle: seek the global maximum while keeping the model as simple as
  possible.
- Requirement DMP.BUCK-R06 requires exact result-affecting inputs and mutation
  proofs for both reruns and non-reruns.
- pnpm lock state represents resolved package versions and peer contexts, while
  internal workspace packages already have a more precise representation as
  Buck dependency edges.
- Shared content-addressed bytes and per-consumer manifests separate physical
  byte reuse from logical dependency authority. This avoids copying identical
  package data into every target identity.
- Exact equivalence for peer contexts, patches, optional/native policy,
  platform filtering, overrides, and workspace injection remains an explicit
  experiment gate before implementation or remote-cache admission.

## Options

| Option                                                              | Tradeoffs                                                                                                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Shared package blobs plus generated per-target closure manifests | Maximizes dependency-byte reuse and invalidation precision; requires a canonical resolver/projection contract and stronger proof surface.                     |
| B. One prepared dependency tree per workspace/profile               | Closest to current Nix machinery and simpler initially; any relevant workspace lock, manifest, policy, or platform identity change invalidates all consumers. |

## Decision

Choose A.

Maintain one canonical dependency resolution/projection contract with three
separate identities:

1. `PackageContentId` identifies normalized package payload bytes from source
   integrity, affected patch bytes, and the materializer/normalization ABI.
2. `PackageContextId` identifies one full pnpm snapshot context from its content
   identity, selected dependency edges, and complete peer bindings.
3. `TaskClosureId` identifies the sorted contexts and workspace providers
   visible to one importer, task class, configured platform, and relevant
   policy/toolchain ABI.

The producer emits shared immutable package blobs, contextual link-graph
records, and a closure manifest for each Buck target. Each target action depends
only on its manifest, exact referenced blobs and contexts, relevant toolchain
and policy records, source inputs, and context-qualified internal Buck target
edges. It must never receive a workspace-global closure manifest merely because
the generator parsed the whole lockfile.

Consumer simplicity is mandatory: a rule receives one closure reference and a
standard projection API. Peer, patch, optional/native, platform, and lockfile
complexity belongs in the canonical producer and its independent proof harness,
not in each target or repository.

## Consequences

- An unrelated lockfile or manifest edit does not invalidate a target when its
  resolved external closure and relevant policy remain byte-identical.
- Package bytes are stored and transferred once per trust domain and platform
  identity, while logical manifests remain small and target-specific.
- Whole-workspace prepared trees may remain temporary compatibility artifacts,
  but they are not the steady-state action-key boundary.
- The design is blocked from authority and remote-cache uploads until
  peer/patch/optional/platform equivalence, deterministic projection,
  cross-worktree replay, negative invalidation, GC, and cache-poisoning controls
  pass.
- Producer and launcher observability must explain both closure identity changes
  and Buck action execution/reuse; a digest without derivation evidence is not
  sufficient.

## Amendment 1: Prototype and Adversarial Constraints

The 2026-08-11 resolver and Buck prototypes preserved a target closure digest
across unrelated lock and package-policy changes, changed it for traversed
integrity and platform changes, and caused zero Buck actions for valid unrelated
closure edits. A relevant manifest edit caused exactly the staging and consumer
actions to run. Removing a required declared package edge failed before the
consumer could use ambient dependencies.

These results preserve the choice of A with the following constraints:

- the lockfile is canonical for contextual package topology, but each target
  must declare roots by importer, task class, and target/exec platform;
- closures are derived from declared dependency categories and explicit
  dynamic/plugin/bin/config capabilities, never inferred from source imports;
- injected workspace dependencies that resolve differently by peer context use
  context-qualified configured Buck providers unless equivalence proves that
  context cannot affect the action;
- pnpm peer suffix strings and virtual-store directory names are not parsed as
  identity; the pinned pnpm implementation and canonical snapshot records are
  used instead;
- Buck's artifact/CAS layer owns package bytes and garbage collection; no custom
  package CAS service is introduced;
- public and private action caches have separate trust domains and write
  authority. Shared public package content is admitted only by sanitized
  content identity and verified provenance;
- projection is a derived artifact, not identity authority, and must reject
  absolute, escaping, dangling, or ambient dependency links;
- raw Buck event logs and build reports remain execution authority. A compact
  receipt joins them to closure manifests, and reports invalidation explanation
  as `exact`, `partial`, or `unknown` instead of guessing from an execution or
  cache miss.

## Amendment 2: Declared-Closure Realization

Buck decision
[0022](../../../buck2/.decisions/0022-lockfile-derived-declared-closure.md)
selects the concrete realization of this identity model: Genie derives one
hash-pinned fetch and extract target per package version from `pnpm-lock.yaml`,
and one assembly target per importer lays out the selected pnpm-shaped closure
with relative symlinks and hardlinks. CPU/OS filtering is mandatory, the
sha256 sidecar is freshness-gated against the lockfile, and no package manager
or custom package CAS runs inside Buck actions.

Decision 0022's prototype evidence and the authority-transfer policy in
[decision 0016](../../../buck2/.decisions/0016-evidence-rigor-at-transfer.md)
supersede the six-item pre-admission blocking gate in the original
Consequences. Exact contextual topology, patches, optional/native selection,
platform filtering, deterministic assembly, relevant and irrelevant
invalidation, and ambient-state removal remain correctness obligations; they
are proved at the authority transfer rather than maintained as a separate live
blocker in this historical record.

The original launcher-observability consequence is also superseded by
[decision 0011](../../../buck2/.decisions/0011-direct-native-evidence-observation.md):
native Buck reports and event logs are execution authority, with observation
owned by the caller rather than an interposed launcher.
