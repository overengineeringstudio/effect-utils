# Buck2 Repository Build Requirements

## Context

These requirements are the cross-cutting invariants of the Buck2 repository
build system. Each subsystem owns its detailed requirements and refines the
invariants named in its own document:

- [01-semantic-graph](./01-semantic-graph/requirements.md) owns authored intent
  and its projection into the Buck graph.
- [05-execution](./05-execution/requirements.md) owns admitted action semantics per language.
- [04-materialization](./04-materialization/requirements.md) owns dependency
  materialization for actions and for the editor surface.
- [06-reuse-client](./06-reuse-client/requirements.md) owns the shared cache and reuse
  criteria.
- [03-consumer-roots](./03-consumer-roots/requirements.md) owns megarepo cell
  composition and action-identity stability.
- [Nix bridge](../05-product-distribution/02-nix-bridge/requirements.md) owns `BuildProduct` and
  independent Nix import.

## Assumptions

- **BUILD.BUCK-A01 Buck execution truth:** Buck's configured graph, action keys,
  event log, and build report are authoritative for Buck analysis and execution.
- **BUILD.BUCK-A02 Nix authority:** Nix owns immutable tool and input recipes, Nix
  store import, and system realization.
- **BUILD.BUCK-A03 Consumer authority:** The system consuming an imported product owns
  deployment, activation, rollback, health, secrets, and fleet policy.
- **BUILD.BUCK-A04 Ecosystem authority:** Package manifests and lockfiles remain the
  semantic dependency request authority even after ecosystem build and install
  commands cease to be producers.
- **BUILD.BUCK-A05 Mitigated tailnet writers:** Any tailnet context may publish
  audited hermetic lanes with revocable per-host write credentials and logged
  action keys. Host-dependent lanes neither read nor write; flaky tests are
  uncached. Public PRs are read-only, enforced server-side. Consumer cache policy
  owns credentials, repo AC instance mangling and purge procedures
  ([decision 0033, Amendment 1](../.decisions/0033-ci-cache-posture-two-trust-tiers.md)).

## Acceptable Tradeoffs

- **BUILD.BUCK-T01 Conservative input closure:** An operation may initially declare a
  measured, visible superset of inputs when it never omits a result-affecting
  input and has an explicit refinement path.
- **BUILD.BUCK-T02 Version-bound evidence adapter:** Rich Buck event-log decoding may
  be pinned to the admitted Buck version while stable build-report fields remain
  tolerant of additive change.
- **BUILD.BUCK-T03 Transitional producers:** A superseded producer may run in parallel
  with its Buck candidate before authority transfer. The transfer change deletes
  it; the parallel period is bounded by the roadmap, never steady state.

## Requirements

### Must preserve narrow authority

- **BUILD.BUCK-R01 Sole producer endgame:** Buck is the terminal authority for every
  bounded deterministic repository-local operation. Admission proceeds slice by
  slice in value order ([roadmap](../.reference/migration-2026/roadmap.md)); each admitted slice has Buck
  as its only producer and gate, and no slice retains a permanent fallback
  ([decision 0001](../.decisions/0001-exclusive-buck-authority.md);
  [decision 0012](../.decisions/0012-vertical-slice-replay-phase.md)).
- **BUILD.BUCK-R02 Bounded operation:** Admission names an operation whose inputs,
  outputs, failure semantics, target platform, and execution platform are
  finite and deterministic. Live effects are outside Buck success.
- **BUILD.BUCK-R03 Directional boundary:** Nix may provide inputs and verify, import,
  wrap, and compose a `BuildProduct`; Buck actions must not evaluate Nix or
  mutate live dependency or system state.
- **BUILD.BUCK-R04 Hermetic execution:** Admitted actions use declared providers and
  inputs, avoid ambient `PATH` and package-manager state, and fail closed on
  undeclared access or incompatible identity.

### Must deliver reuse and speed

- **BUILD.BUCK-R05 Exact portable identity:** An action identity contains every
  result-affecting source, dependency closure, configuration, toolchain,
  platform, and policy input, excludes irrelevant host state, and is stable
  across worktrees and machines of one repository. Cross-repository identity is
  the product digest a consumer pins, not a shared action key
  ([decision 0034](../.decisions/0034-artifact-default-composition-no-registry.md)).
- **BUILD.BUCK-R06 Shared reuse:** Audited hermetic admitted command actions read
  the remote action cache and write when consumer policy authorizes their context;
  host-dependent lanes neither read nor write and flaky tests are uncached.
  Immutable third-party inputs are acquired
  from that tier's CAS by reviewed digest and byte size (decisions 0033 and
  0038). A second same-platform standalone checkout of the same repository at
  an identical revision re-executes zero command actions for unchanged admitted
  targets and performs no origin transfer for CAS-present inputs; a violation
  is a key-stability regression
  ([06-reuse-client](./06-reuse-client/requirements.md),
  [second-context key-stability evidence](../.experiments/2026-09-19-second-context-key-stability.md)).
  Untrusted public contexts are read-only.
- **BUILD.BUCK-R07 Lane budgets:** Edit-run, quick check, full tests, and
  platform/host proof have independently measured wall-clock budgets. The first
  honest measurement pass supplies the numbers; until then values remain
  [BUILD.BUCK.REUSE-DQ01](./06-reuse-client/spec.md#open-design-questions), not invented
  limits. Once set, admission widening that breaks a lane budget is a regression
  to fix before widening further.
- **BUILD.BUCK-R08 Disk anti-duplication:** Dependency and output materialization
  must not duplicate bytes per worktree where a shared content-addressed store
  or hardlink mechanism exists. Buck-owned state (`buck-out`, isolation dirs)
  carries the same anti-duplication obligation as the pnpm store contract.

### Must dissolve superseded systems


- **BUILD.BUCK-R10 FOD dissolution:** Admitted repository-local tools reach Nix
  consumers only through product import; their dependency closures cause zero
  fixed-output hash maintenance.
- **BUILD.BUCK-R11 Dependency authority:** Buck owns dependency materialization end
  to end, including the editor surface. Manifest and lockfile state is the only
  hand-authored dependency input; a stale materialized surface fails loudly
  before it can produce a wrong result
  ([decision 0015](../.decisions/0015-buck-owned-dependency-surface.md) for
  authority; [decision 0022](../.decisions/0022-lockfile-derived-declared-closure.md)
  for mechanism).

### Must be observable and provable at the right moments


- **BUILD.BUCK-R13 Native evidence and telemetry independence:** Buck-native evidence
  remains execution truth. Telemetry links to it without replacing it; export
  failure never changes Buck's result; metrics carry only bounded attributes.

### Must reduce global complexity measurably



- **BUILD.BUCK-R17 Remote command execution:** Every admitted result-producing command
  action can execute through REAPI on a compatible fleet worker whose execution
  platform identifies its exact Nix tool closure
  ([05-execution](./05-execution/requirements.md), decision 0006). Client-side
  source acquisition, digest verification, and materialization are not remote
  command execution; they expose immutable CAS digests so remotely executed
  consumers receive identical inputs. Local and remote command results and
  identities are equal (BUILD.BUCK-R05), and execution never widens a cache trust
  tier (decision 0033).
