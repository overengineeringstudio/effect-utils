# Buck2 Evidence Spec

This document specifies the Buck2 boundary for repository-local builds and its
bridge to Nix-managed development and system state. It builds on
[requirements.md](./requirements.md) and the accepted decisions in
[`.decisions/`](./.decisions/).

Status: **Foundation implemented; authority admission pending**

The implemented foundation includes exact-closure discovery and compiler APIs,
strict Buck projection rules, a thin evidence-producing launcher, Nix
artifact/toolchain bridge helpers, a generated `tui-core` input-plan target,
local-only Buck smoke targets, and a benchmark harness. It does not yet
materialize normalized package payloads or make Buck dependency materialization
authoritative for production packages. Remote cache reads and writes and remote
execution are explicitly disabled until the admission gates in this document
pass.

## Requirement Trace

| Spec section                         | Requirements                                                         |
| ------------------------------------ | -------------------------------------------------------------------- |
| Authority boundary                   | DMP.BUCK-R01, DMP.BUCK-R04, DMP.BUCK-R05, DMP.BUCK-R08               |
| Dependency and cache identity        | DMP.BUCK-R01, DMP.BUCK-R06, DMP.BUCK-R09, DMP.BUCK-R10               |
| Generated graph                      | DMP.BUCK-R01, DMP.BUCK-R06, DMP.BUCK-R09, DMP.BUCK-R10               |
| Toolchain and artifact bridges       | DMP.BUCK-R01, DMP.BUCK-R03, DMP.BUCK-R05, DMP.BUCK-R11               |
| Execution evidence and observability | DMP.BUCK-R02, DMP.BUCK-R03, DMP.BUCK-R07, DMP.BUCK-R08, DMP.BUCK-R12 |
| Benchmark method                     | DMP.BUCK-R06, DMP.BUCK-R07                                           |
| Rollout and admission                | DMP.BUCK-R05, DMP.BUCK-R06, DMP.BUCK-R07, DMP.BUCK-R11, DMP.BUCK-R12 |

## Authority Boundary

The system has one owner for each class of state. A bridge transfers immutable
artifacts or delegates a command; it does not merge authorities.

| Concern                                                              | Authority                                 | Contract                                                                                                          |
| -------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Tool recipes, versions, patches, source provenance                   | Nix                                       | Export a normalized relocatable archive, or build an execution image for a non-relocatable closure.               |
| Developer shell, setup, services, secrets, compatibility task names  | devenv                                    | Realize tools once and delegate hot build requests to the launcher. Do not sit in front of every Buck invocation. |
| Repo-local target graph, action inputs, compilation and bundling     | Buck2                                     | Consume explicit source, configuration, closure, toolchain, policy, and platform inputs.                          |
| Package graph and target-local closure generation                    | Genie plus the canonical closure compiler | Generate deterministic, checked-in, package-local `BUCK` and closure shards.                                      |
| Build execution evidence                                             | Buck event log and build report           | Remain the execution authority; the launcher retains and indexes them.                                            |
| Deployable repo artifact                                             | Buck2, after admission                    | Produce one normalized per-platform artifact and descriptor with provenance plus runtime ABI.                     |
| Artifact verification and immutable import                           | Nix                                       | Verify digest, platform, archive safety, relocatability, and provenance; fail closed on mismatch or absence.      |
| Runtime dependencies, wrappers, user/system convergence and rollback | Nix, Home Manager, NixOS or nix-darwin    | Compose an imported artifact into an independently reversible generation.                                         |
| Fleet aliases, endpoints, activation policy and private topology     | Downstream system repository              | Stay outside this public reusable repository and outside cache identities unless result-affecting.                |

The intended steady-state flow is:

```text
Nix tool recipes                         package metadata + pnpm lock
       |                                          |
       v                                          v
portable tool archive or image digest      Genie closure compiler
       |                                          |
       +----------------+-------------------------+
                        |
                        v
              generated package-local BUCK
              + target-local closure shards
                        |
                        v
              Buck action and artifact
                        |
              digest + provenance descriptor
                        |
                        v
                 verified Nix import
                        |
                        v
              Home Manager/system activation
```

Normal Nix evaluation or activation must never start a live Buck daemon or
build from a mutable checkout. An optional dirty-development bridge must be
named as such and cannot claim to produce a reproducible Nix generation.

## Dependency and Cache Identity

Exact invalidation requires three identities instead of one workspace-wide
dependency digest:

```text
PackageContentId
  = normalized package bytes
  + source integrity
  + applicable patch bytes
  + materializer/normalization ABI
          |
          v
PackageContextId
  = PackageContentId
  + selected dependency edges
  + complete peer bindings
          |
          v
TaskClosureId
  = importer + task class + explicit roots/capabilities
  + target and execution platforms
  + sorted package contexts and workspace providers
  + closure-compiler ABI
```

Equal package bytes are stored once per cache trust domain. Context records
retain pnpm peer topology without duplicating those bytes. A task consumes only
its generated closure manifest, referenced package artifacts and contexts,
context-qualified workspace providers, declared sources/configuration, and the
relevant toolchain/platform/policy identities.

Toolchain identity and execution-image identity remain separate Buck action-key
dimensions. They must invalidate actions that execute those tools without
changing an otherwise equal dependency closure identity.

The lockfile is a generator input and topology authority; it is not itself an
action input for every generated target. An unrelated lockfile, package
manifest, or policy edit must leave `TaskClosureId` and the Buck action key
unchanged when the resolved observable closure is byte-identical.

The schema carries task class (`runtime`, `check`, `test`, or `tool`), target
and execution platforms, and explicit dynamic capabilities from its first
version. The first shadow target may declare a visibly
`conservative-full-importer` closure. That is a measured compatibility state,
not the steady-state default. Role splitting follows when closure size,
transfer, projection, or invalidation measurements show material benefit.

No action may resolve packages through ambient `node_modules`, a mutable pnpm
store, or undeclared host links. Projection must fail on a missing manifest
edge, extra declared artifact, digest mismatch, absolute or escaping path,
dangling link, or ambient dependency access.

### Source observation

Correct declared-input invalidation also depends on Buck observing the
canonical repository path. The repository therefore uses
`[buck2] file_watcher = watchman` and ignores root/nested
`node_modules` trees plus root/nested Cargo `target` trees. Oxlint's injected
root config is a persistent, locked, atomically replaced cache rather than a
create/delete temporary file, preventing crawler read races. Both the directory
and descendant glob are required for nested generated trees.
The default Linux notify backend is not admitted for this pnpm workspace: its
directory-symlink forest can expose one source inode through many ignored
`node_modules` aliases, and the backend may report only an ignored alias while
leaving the canonical source node stale in DICE.

Watchman is the correctness-first event backend. The hash crawler was rejected
after concurrent repository file deletion failed its whole-tree initialization
scan. Watchman must retain the same relevant-content, mtime-only,
unrelated-content, daemon-restart, and cross-platform controls; watcher speed is
not allowed to weaken cache correctness.

## Generated Graph

Genie is the repository authoring boundary for generated graph data:

- each stable package boundary owns a checked-in generated `BUCK` file and
  target-local closure descriptor shards;
- package manifests, TypeScript project edges, the canonical lock compiler,
  and explicit target metadata are generator inputs;
- shared providers and rules remain hand-authored `.bzl` modules;
- source and configuration lists are explicit, so an undeclared new file fails
  freshness instead of silently changing an action;
- generation is deterministic and content-stable: changing package A cannot
  rewrite package B when B's configured graph is unchanged; and
- a whole-repository graph export is derived evidence, never a common analysis
  input loaded by every package.

Generated files carry the repository's standard provenance and are protected by
the existing Genie freshness check. Their deterministic graph content is the
freshness boundary; unrelated source bytes are not hashed into a `BUCK` file,
because doing so would invalidate analysis without changing its semantics.
Package moves update old and new ownership, stable labels or intentional
aliases, and closure references atomically.

The implemented pnpm lockfile-v9 APIs handle peer contexts, workspace links,
aliases, optional/platform selection, and patches fail-closed. Input discovery
returns the exact contextual package sources and policy reachability needed for
materialization, but intentionally returns no authoritative content, context,
or task IDs. The authoritative compiler mints those identities only when every
selected package has a verified digest of its normalized final tree after
patches and package-specific build policy. Registry archive integrity is source
evidence, not that normalized-payload digest.

The caller must parse YAML with the pinned runtime, run pnpm frozen-lock/config
validation, supply generated task roots, materialize and normalize the selected
packages, and provide verified payload evidence. Non-registry sources lacking
lockfile integrity also require an independently verified source-content
digest. Until the materializer and parity matrix pass, the compiler is evidence
rather than dependency-materialization authority.

### First package-local target

`//packages/@overeng/tui-core:typescript_input_plan` is the first generated
package-local target. Genie explicitly lists its TypeScript sources and
configuration and emits a conservative full-importer plan derived from the
lockfile and the package-relevant projection of materializer policy. The plan
declares itself `non-authoritative-input-plan`, names the later Buck action as
the required authoritative compiler boundary, and disables remote admission.

The generated target explicitly requires `x86_64-linux`. The local-only
`package_task` compares that requirement with Buck's analysis-host identity and
fails before execution on a mismatch; an `aarch64-linux` control on the current
x86_64 host is therefore RED. This host check is a bootstrap safety boundary,
not a configured execution-platform implementation. Binding target and
execution constraints to remote-capable Buck platforms remains deferred until
remote execution admission.

The current Buck `package_task` hashes those declared inputs and packages the
plan into a deterministic evidence archive with an import descriptor. It does
not install dependencies, materialize normalized package trees, run TypeScript,
or claim build-output equivalence. Its successful Nix import proves the
artifact bridge and source/configuration census, not an authoritative package
build or closure.

While the existing Materialization Profile remains authoritative, generated
evidence must retain its profile identity, relevant policy digest,
repo-relative semantic input digests, and named materialization authority. A
target-local closure descriptor is the eventual more precise replacement for
that dependency identity, not permission to omit its derivation evidence.

## Toolchain and Artifact Bridges

### Nix to Buck toolchains

Nix remains the single tool recipe and pin authority. It exports a normalized
per-platform archive plus a descriptor containing digest, size, entrypoints,
platform, and provenance. Buck consumes the archive or image digest through a
stable toolchain provider; authoritative Buck actions do not invoke Nix
evaluation or the Nix daemon.

Simple tools must be relocatable and pass store-reference, archive traversal,
symlink escape, executable-entrypoint, empty/hostile `PATH`, and byte-stability
checks. A native closure that cannot satisfy those constraints becomes a
Nix-built execution image whose immutable digest participates in Buck execution
platform identity.

Raw `/nix/store` executables are permitted only for explicitly local bootstrap
or evidence targets with remote cache reads, remote cache writes, and remote
execution disabled. They are not authority-grade toolchains.

The current portable-provider target is synthetic evidence. It produces an
archive/descriptor fixture with the Nix-export shape, verifies both byte
digests, stages the archive, and executes its entrypoint with a hostile
`PATH`. This proves the provider and verifier interface without claiming that
the fixture was exported by a real Nix tool recipe.

The verifier and current `package_task` are themselves Python rules built with
the bundled Prelude demo toolchain. That Prelude path is a bootstrap dependency,
not the accepted production toolchain. These targets remain local-only with
remote cache disabled until the bootstrap is replaced by a reviewed,
Nix-exported portable provider or execution image. Production package actions
must consume that portable provider and must not inherit the Prelude demo
toolchain implicitly.

### Buck to Nix deployable artifacts

After artifact admission, Buck owns compilation and bundling and emits a
normalized per-platform archive plus a descriptor containing the artifact
digest, size, platform, provenance, and build identity. Nix imports it as a
verified fixed-output artifact, scans it, and then adds runtime dependencies or
wrappers without rebuilding the repository sources.

Import fails closed on a wrong digest, wrong platform, unsafe archive path,
escaping symlink, Nix-store reference, malformed descriptor, or unavailable
artifact. It never falls back silently to a source build. Existing Nix source
builders remain explicit shadow fallbacks until output and behavior
equivalence, relocation, activation, verification, and rollback are proven.

## Launcher, Execution Evidence, and Observability

The effect-utils launcher is a thin, bypassable hot-path boundary. It invokes
an already-realized pinned Buck binary directly and passes Buck arguments and
exit status through. It may resolve stable human-facing aliases, but it must
not own source sets, dependency edges, rules, execution policy, or a parallel
task DAG. It prints the underlying command on request, and direct Buck remains
available for diagnosis.

For supported execution commands, the launcher requests and retains Buck's
event log, build report, artifact hashes, and build identifier. It writes a
mode-0600 `buck-run-receipt/v1` as a compact, content-addressed join over those
native records and supplied closure manifests. The receipt is an index, not an
alternative execution oracle.

Evidence distinguishes at least:

| Outcome                                  | Meaning                                                                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `dice_reuse`                             | A prior controlled receipt has equal requested output digests and Buck reports neither action execution nor materialization. |
| `local_cache_hit` / `remote_cache_hit`   | Buck reports reuse of an action result from the named cache tier.                                                            |
| `local_cache_miss` / `remote_cache_miss` | Buck reports a lookup miss separately from subsequent execution.                                                             |
| `local_execution` / `remote_execution`   | Buck reports command execution on the named executor.                                                                        |
| `materialized_only`                      | Existing output bytes were fetched or written without relabeling that operation as execution.                                |
| `failed`, `cancelled`, `unknown`         | Evidence does not justify a stronger successful-outcome claim.                                                               |

Execution or a cache miss does not by itself explain invalidation. Comparing
canonical closure manifests can make the external-closure explanation exact;
all other explanations remain `partial` or `unknown` until their own canonical
identity evidence is joined.

The implemented runtime observability boundary is the structured receipt plus
retained Buck event logs and build reports. Receipt observation is complete
only when both native artifacts exist, both supported Buck log queries succeed,
and every nonblank query record parses with supported semantics. Incomplete or
unknown evidence yields no invalidation verdict.

Telemetry is schema-first, but the launcher does not export OTLP at runtime yet.
The registered contract defines the future span and bounded outcome metric
surface. Target labels, invocation IDs, artifact digests, closure IDs, and
evidence paths are high-cardinality trace fields and must not be metric labels.
The future exporter must use the repository OTEL contract, including
`span.label`, and link to retained native evidence without copying raw commands,
environments, secrets, absolute project roots, credentials, or host-private
paths into public artifacts.

## Devenv Integration

Devenv provides compatibility and lifecycle tasks, not the performance-critical
transport. The implemented task family is:

| Task                                 | Purpose                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `buck2:build:foundation`             | Build the strict synthetic closure foundation locally with remote cache disabled.                                  |
| `buck2:test:foundation`              | Run the closure-tool tests under the same local-only policy.                                                       |
| `buck2:e2e:tui-core`                 | Regenerate, build, observe, Nix-import, and execute the non-authoritative `tui-core` input-plan evidence artifact. |
| `buck2:build:megarepo`               | Typecheck `mr` and compile/package its generated first-party runtime graph.                                        |
| `buck2:test:typescript`              | Test deterministic TypeScript CLI staging, packaging, and descriptor generation.                                   |
| `buck2:e2e:megarepo`                 | Retain Buck evidence, import the exact `mr` artifact through Nix, and execute it with an empty `PATH`.             |
| `buck2:invalidation:e2e:megarepo`    | Assert warm, mtime, relevant-source, restoration, and excluded-test invalidation behavior.                         |
| `buck2:benchmark:megarepo`           | Measure `mr` warm and controlled mutation phases with native Buck evidence.                                        |
| `buck2:build:otel-scrape`            | Compile the native Reindeer Rust graph and deterministic store-independent ELF artifact.                           |
| `buck2:test:otel-scrape`             | Run the native unit and CLI integration targets without delegating to Cargo.                                       |
| `buck2:e2e:otel-scrape`              | Verify/import the exact Buck bytes, relocate their runtime through Nix, and run with an empty environment.         |
| `buck2:invalidation:e2e:otel-scrape` | Prove warm, mtime, source, provenance-only, restoration, and integration-only invalidation boundaries.             |
| `buck2:benchmark:otel-scrape`        | Measure native Rust warm and controlled mutation phases with action and binary-digest evidence.                    |
| `buck2:reindeer:check:otel-scrape`   | Regenerate the committed third-party target graph and require byte identity.                                       |
| `buck2:nix-bridge:check`             | Exercise portable tool export and verified artifact import, including negative controls.                           |
| `buck2:benchmark:check`              | Validate the benchmark parser and dry-run matrix.                                                                  |
| `buck2:check`                        | Aggregate the Buck2 foundation plus admitted local `mr` and `otel-scrape` checks.                                  |

These tasks are setup/CI compatibility surfaces. Interactive and performance
measurements use the already-realized launcher directly so fresh Nix/devenv
evaluation is not charged to every Buck request.

## Benchmark Method

Benchmarks compare one immutable Git revision and record exact tool versions,
a non-sensitive host class, cache treatment, initial/final cache size and file
count, command-output hashes, action/materialization counts when available, and
raw plus aggregate JSONL. Unavailable prerequisites or evidence produce
`skipped` or `no-verdict`, never an inferred success.

Report end-user latency and compute-only latency separately:

| Lane                | Required phases                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| Devenv end-user     | Profile-cold/store-warm first invocation; warm no-op.                                           |
| Devenv compute-only | Compiler-clean; warm no-op; mtime-only; relevant-content; irrelevant-content mutations.         |
| Buck local-only     | Clean action cache; warm no-op; daemon restart with cache retained; the same mutation controls. |

The default harness uses a detached scratch worktree. It does not drop kernel
page caches, run Nix GC, prune a pnpm store, or call a fresh worktree a cold Nix
store. Buck runs use local execution with remote cache disabled. A timing is not
hermeticity evidence: every invalidation conclusion also requires native action
and materialization evidence plus RED/GREEN controls.

The declared-source control must assert the target-specific minimal action set,
its exact execution count, and artifact digest. A single-action target therefore
expects exactly one action; a compiled library plus binary link expects exactly
those two named actions and no others. The admitted local pattern is: baseline
digest, content mutation with the declared minimal action set and a different
digest, then byte restoration with the same action set and the original digest
again. Revision-varying build identity belongs on the executable leaf: changing
only the revision must relink the binary exactly once without recompiling its
library. Restoring the revision must reproduce the baseline binary digest. A
watcher that returns a warm zero-action result for the mutation, or
a graph that executes undeclared extra actions, fails this gate regardless of
its latency.

## Rollout and Admission

Rollout is target-by-target and reversible:

1. **Foundation:** local synthetic strict projection, discovery/compiler APIs,
   portable-provider fixture, launcher, bridge, receipts, and benchmark harness.
   This is implemented.
2. **Input-plan E2E:** generate the conservative package-local `tui-core` input
   plan; package it with declared source/config inputs; retain Buck evidence;
   verify and import it through Nix; and execute it under an empty `PATH`. This
   is implemented but explicitly non-authoritative.
3. **Authoritative shadow target:** materialize and hash normalized final
   package trees inside Buck, compile authoritative content/context/task IDs,
   and compare a real TypeScript action's output and behavior with the current
   authoritative path while all cache access remains local-only.
4. **Role refinement:** split runtime/check/test/tool roots where measurements
   show material benefit and prove relevant and irrelevant invalidation.
5. **Artifact import:** publish a normalized Buck build artifact and prove the Nix
   fixed-output import, activation, verification, fallback, and rollback lanes.
6. **Read-only cache:** admit cache reads within an isolated public trust domain
   only after hermetic replay and poisoning controls pass.
7. **Cache writes:** grant narrowly scoped write authority only after provenance,
   namespace, credential-isolation, and corruption controls pass.
8. **Remote execution:** admit per-platform execution only after portable
   toolchain/archive or execution-image, cross-host replay, and resource/evidence
   parity pass.
9. **Additional megarepos:** reuse the stable public launcher and providers;
   keep repository graph, aliases, policy, system activation, and private
   topology consumer-owned.

Before any authoritative package target, remote-cache write, or remote
execution, the relevant lane must prove:

- pnpm parity for peers, injected workspace packages, links, aliases, patches,
  overrides/extensions, optional/native packages, bins, dynamic/plugin/config
  access, lifecycle-script disablement by construction, and exact target/exec
  platform selection;
- deterministic projection and artifacts with no absolute, escaping, dangling,
  ambient, or Nix-store references;
- relevant RED/GREEN and irrelevant negative controls across warm daemon,
  restarted daemon, clean worktree, cross-worktree, and cross-host replay;
- closure/action identity stability for irrelevant lock and package changes;
- public/private cache namespace and credential isolation, verified provenance,
  and corrupted or malicious result rejection;
- artifact digest/platform tamper rejection, Nix import, runtime verification,
  activation, and rollback; and
- complete, secret-safe native reports/logs joined to closure evidence with
  explicit `exact`, `partial`, or `unknown` invalidation explanations.

Until those gates pass, the normative policy is:

```text
local execution:     allowed for evidence and shadow comparisons
remote cache reads:  disabled
remote cache writes: disabled
remote execution:    disabled
system activation:   current Nix/Home Manager authority only
```
