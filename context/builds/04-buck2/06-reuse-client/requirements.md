# Reuse Requirements

This subsystem owns the shared cache and the reuse criteria. It refines
BUILD.BUCK-R06 and BUILD.BUCK-R07. Service deployment authority is dotfiles-owned
(dotfiles#2009); consumer trust sequencing is effect-utils#1054.

## Assumptions

- **BUILD.BUCK.REUSE-A01 Cache policy:** Consumer policy selects the cache endpoint
  and authorizes tailnet writers with mitigations; only audited hermetic lanes
  publish. Host-dependent lanes neither read nor write, flaky tests are uncached,
  and public PRs are read-only under server enforcement
  ([decision 0033, Amendment 1](../../.decisions/0033-ci-cache-posture-two-trust-tiers.md)).
- **BUILD.BUCK.REUSE-A02 Disposable state:** CAS and action-cache content is rebuildable
  by definition; wiping or swapping the backend costs a cold period, never
  data.

## Acceptable Tradeoffs

- **BUILD.BUCK.REUSE-T01 Host-dependent exceptions:** Actions whose outputs depend
  on undeclared machine-local paths are local-only and excluded from cache reads
  and writes; their hermetic consumers are not. Immutable declared Nix tools
  and local-only placement alone do not make an action host-dependent.

## Requirements

- **BUILD.BUCK.REUSE-R01 Remote-first admitted actions:** Audited hermetic admitted
  actions read the shared cache and may write when consumer policy authorizes
  their tailnet context (`remote_cache_enabled`, `allow_cache_uploads`,
  `default_allow_cache_upload`). Public PRs are read-only. Host-dependent lanes
  neither read nor write; flaky tests are uncached. `local_only` constrains
  execution placement, not cache eligibility.
- **BUILD.BUCK.REUSE-R02 Zero re-execution:** A second same-platform context at an
  identical revision re-executes zero actions for unchanged admitted targets.
  Any local re-execution is a key-stability regression and is triaged as a
  defect, not accepted as noise.
- **BUILD.BUCK.REUSE-R03 Budgets:** Measure edit-run, quick check, full tests, and
  platform/host proof independently under BUILD.BUCK-R07. Budget values remain
  open until the first honest measurement pass; a regression against a set lane
  budget blocks admission widening.
- **BUILD.BUCK.REUSE-R04 Outage posture:** An unreachable cache is a hard action failure
  in the pinned Buck2. The consumer contract provides a one-line disable
  toggle, and the service is monitored and alerted so an outage is an
  operations event, not a silent slowdown.
- **BUILD.BUCK.REUSE-R05 Digest and transport discipline:** SHA256 digests are pinned
  explicitly; the client configuration lives in a buckconfig file (CLI
  overrides do not reach the RE client); batched transfers stay below Buck2's
  4 MiB gRPC client limit, enforced on the client side — bazel-remote
  advertises no batch cap in its Capabilities response, so the server cannot
  enforce this (facebook/buck2#583).
- **BUILD.BUCK.REUSE-R06 Repository action namespaces:** Shared-cache services
  enable AC key instance mangling per repository; `instance_name` alone is not
  isolation. CAS remains shared within its trust domain. Revocable per-host
  credentials and logged action keys support writer quarantine and targeted AC
  purge; neither digest validation nor namespace selection grants write trust.
- **BUILD.BUCK.REUSE-R07 Output economics:** Cache-uploaded outputs are slim (verdicts,
  dists, descriptors), not staged input trees. Buck-owned local state
  (`buck-out`, isolation dirs) observes BUILD.BUCK-R08: no per-invocation isolation
  dirs, stale state reclaimed (`buck2 clean --stale`).
