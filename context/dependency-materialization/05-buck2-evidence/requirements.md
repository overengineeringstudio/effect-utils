# Buck2 Evidence Requirements

## Context

Buck2 evidence is the initial Buck2 boundary for dependency materialization.
Buck2 may consume deterministic dependency facts before it owns hermetic
dependency building or host-local pnpm repair.

## Assumptions

- **A01 Materialization Profile identity:** Buck2 evidence consumes the shared
  DMP Materialization Profile identity.
- **A02 No live repair:** Live mutable pnpm install and repair remain outside
  Buck2 until a hermetic action is proven.

## Acceptable Tradeoffs

- **T01 Evidence first:** Buck2 may start with Materialization Profile evidence
  targets instead of full dependency materialization targets.

## Requirements

### Must be declared graph input

- **DMP.BUCK-R01 Declared inputs:** Buck2 targets must depend on declared
  dependency inputs or immutable artifacts, not ambient pnpm store contents.
  Refines: DMP-R09, DMP-R10.
- **DMP.BUCK-R02 Stable evidence:** Evidence must include Materialization Profile
  identity, policy digest, input digests, and materialization authority.
  Refines: DMP-R10.
- **DMP.BUCK-R03 No secret keys:** Evidence must not include credentials or
  host-private paths.
  Refines: DMP-R10.

### Must preserve authority boundaries

- **DMP.BUCK-R04 No live ownership:** Buck2 evidence targets must not silently
  run live pnpm install, shared-store GC, or repair.
  Refines: DMP-R11, DMP-R12.
- **DMP.BUCK-R05 Future hermetic path:** A future Buck2 dependency builder must
  declare the same Materialization Profile inputs and prove output equivalence
  against the Nix or live realization it replaces.
  Refines: DMP-R10, DMP-R16.

### Must minimize and explain invalidation

- **DMP.BUCK-R06 Exact invalidation:** Generated fine-grained targets must
  declare only their result-affecting source, dependency, configuration,
  toolchain, platform, and policy inputs. Admission requires RED/GREEN mutation
  controls proving that relevant changes rerun the exact affected closure and
  irrelevant changes do not.
  Refines: DMP-R09, DMP-R10.
- **DMP.BUCK-R07 Observable execution:** Every authoritative Buck path must
  expose target and action identity, the reason an action ran or was reused,
  local/remote/cache outcome, analysis and execution timing, resource and
  transfer/materialization measurements, and correlation to retained build
  reports or traces. An unexplained cache hit is not admissible freshness
  evidence.
  Refines: DMP-R10.
- **DMP.BUCK-R08 Transparent launcher:** The effect-utils hot-path launcher must
  invoke the already-realized pinned Buck binary without fresh Nix or devenv
  evaluation, preserve target labels and exit status, retain the underlying
  Buck command and evidence paths, and own no duplicate dependency or task
  graph.
  Refines: DMP.BUCK-R06, DMP.BUCK-R07.
- **DMP.BUCK-R09 Closure-scoped dependency identity:** Authoritative Buck
  targets must consume generated identities for only the resolved external
  dependency contexts they can observe for their importer, task class, and
  configured target/exec platform, backed by shared immutable package bytes.
  Internal workspace dependencies remain context-qualified Buck target edges
  where peer bindings can affect resolution. An unrelated lockfile change must
  not invalidate a target whose resolved closure and relevant policy are
  unchanged.
  Refines: DMP.BUCK-R01, DMP.BUCK-R06.
- **DMP.BUCK-R10 Layered content identity:** Dependency identity must separate
  normalized package payload bytes, full pnpm snapshot/peer contexts, and
  target-local closure roots. Generated target inputs must be sharded so a
  workspace-global lock parse or codegen run does not make unrelated lock state
  part of every action key.
  Refines: DMP.BUCK-R06, DMP.BUCK-R09.
- **DMP.BUCK-R11 Cache trust domains:** Public and private repositories must not
  share writable action-cache authority. Remote-cache admission requires
  declared hermetic inputs, path-independent replay, verified artifact
  provenance, isolated credentials/namespaces, and poisoning negative controls.
  Refines: DMP.BUCK-R01, DMP.BUCK-R03, DMP.BUCK-R06.
- **DMP.BUCK-R12 Native evidence join:** Raw Buck event logs and build reports
  remain execution authority. Generated closure manifests remain dependency
  identity authority. The launcher may emit a compact content-addressed receipt
  joining them, but must represent DICE reuse, local/remote cache hits,
  execution, and materialization separately and must not infer an invalidation
  reason from execution alone.
  Refines: DMP.BUCK-R07, DMP.BUCK-R08.
