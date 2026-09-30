# 0039 Namespace First Remote Candidate; Adoption Deferred

Status: accepted

Accepted 2026-09-30 by Johannes (decisions q1–q7).

## Context

BUCK-R17 separates remote command execution from client acquisition and Nix
product distribution. The [Namespace experiment](../.experiments/2026-09-30-namespace-remote-execution.md)
proves AC/CAS/TLS interoperability, real Linux typecheck/emit/test execution,
byte-equal emit, and post-clean reuse. Named pools can hold the exact Nix
capability closure without a self-hosted scheduler/worker fleet.

## Evidence and Argument

The fair clean `//:quick` benchmark does not justify default RE for speed:
cold RE took 235.276 s against 34.668/36.053 s local (6.65× the local mean).
Warm-worker execution with AC bypassed still took 130.680 s. Clean-client AC
reuse took 5.105 s. Roughly 1,100 tiny store/extract actions have 11–12 ms median
command time against about 130 ms median remote lifecycle cost. Worker boot
and roughly 670 MiB client downloads add cost; they do not alone explain it.

Public-cache replacement is also blocked: read-only setup returns a bearer
that can write AC entries and execute after switching endpoints. Different
`--key` values share AC entries. Neither flag enforces a trust boundary. Real
Darwin graph execution remains unproved because its capability closure was not
fully substitutable.

Adoption must be weighed against total recurring complexity, including repo
configuration and consumer pins, fleet retirement, credentials/onboarding,
closure publication, pool lifecycle, quotas, outages, evidence, and billing.
The surface inventory touches 14 groups for public cache, 10 more stage-touched
groups for Linux RE, and 5 for macOS RE; overlap gives 18/19 distinct cumulative
groups. A five-file proof patch is not the production adoption surface.

## Options

| Option                 | Tradeoff                                                                                                                                                                                                                          | Outcome                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Namespace              | Proven protocol and Linux closure execution; avoids a new public scheduler/worker fleet. Adds vendor auth, provisioning, pool lifecycle, billing, and client materialization costs. Reader policy and cold latency block rollout. | First candidate on re-entry; no rollout now |
| Self-hosted NativeLink | Owns execution policy and infrastructure. Adds scheduler/worker operations, TLS/auth, packaging, storage, and host capacity obligations. The earlier experiment could not safely acquire NativeLink and ran no actions.           | Not the first Phase 7 candidate             |
| Defer or drop RE       | Keeps local execution and existing cache tiers; adds no remote execution machinery. Does not close BUCK-R17 or rule out a later capacity/workload case.                                                                           | Defer; do not drop the requirement          |

## Decision

1. Defer rollout. Retarget roadmap Phase 7 from self-hosted NativeLink to
   Namespace as the first candidate, not an approved deployment.
2. Re-enter through the independent tracks below, cache first. A trigger
   authorizes a bounded proof, not automatic migration. Preserve decision
   [0033](./0033-ci-cache-posture-two-trust-tiers.md)'s server-enforced trust and
   outage gates.
3. Keep the public shared cache on self-hosted bazel-remote until Track A
   completes. Keep the private cache and private execution boundary unchanged.
   No private artifacts, signing credentials, or tailnet reachability enter
   public Namespace workers.
4. Preserve Nix/Cachix as capability and product-distribution authority and Buck
   native logs as action evidence. Namespace invocation reports are empty
   without BEP; they do not replace that evidence.
5. Keep decisions 0013 and 0037 as history. This decision changes Phase 7's
   candidate and entry gates, not the product-distribution contract.

## Re-entry Tracks

| Track                       | Entry trigger                                                                                                                                                                                                                                                 | Proof before completion                                                                                                                                                                                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — public shared cache** | Namespace ships a non-escalatable reader / branch-scoped writer identity, proven by rerunning the TrustTierReview escalation test.                                                                                                                            | Endpoint switching, RW setup, token minting, AC update, CAS upload, and scheduler execution cannot elevate the reader; protected-main writer authorization, unchanged-head reuse, AC/CAS/TLS, and outage posture work for public consumers. Only then replace public bazel-remote.                                |
| **B — Linux RE**            | Either (1) tiny pnpm store/extract actions are local-only or coarsened **and** a FairConcurrencyBench rerun shows RE cold ≤ local cold, **or** (2) measured local build capacity, specifically runner queueing, is the CI bottleneck for public repositories. | Prove admitted real command/test lanes execute without hidden fallback using the exact closure and projection root; compare bytes, cold execution, AC reuse, queueing, transfers, and cost at explicit concurrency. Trusted execution authority and worker isolation remain required, even for the capacity path. |
| **C — macOS RE**            | A named Darwin workload needs RE **and** the Darwin capability closure is substitutable from Cachix.                                                                                                                                                          | Prove that workload on the exact Darwin closure, including SDK/runtime needs, without local fallback. Bound trusted-only worker reuse, spend, and outage behavior; synthetic hello is insufficient.                                                                                                               |

Track B can justify a bounded trusted-public execution experiment without
completing Track A. It does not authorize giving untrusted jobs the tested
bearer or treating two public cache backends as the steady-state target.
Track C does not inherit a Linux closure or a synthetic Darwin proof.

## Consequences

- There is no new rollout, credential distribution, or production platform
  change from this record. The proof patch remains an experiment fixture.
- The worker-image mechanism is specified: one immutable named pool per
  capability closure identity; startup realizes the complete closure including
  its projection root; platform properties bind that identity into the action
  key. Tests need project-relative paths and the compatible-RE opt-in flag.
- Track A completion deletes public bazel-remote service/storage/auth/ingress,
  activation, and public-specific monitoring. The generic module and private
  tier remain. Retaining duplicate public caches indefinitely is not the target.
- Linux/macOS RE does not by itself remove CI runners, native Nix builders,
  local admission/locks, or observability. Budget, quota, identity renewal,
  immutable pool lifecycle/GC, and support ownership remain adoption costs.
- Public execution needs a public-only workspace and intentional publisher
  trust set, not reuse of the experiment workspace or cluster keys as isolation.
  Exact RE pricing and traffic terms need invoice/support evidence before a
  savings claim; published macOS compute has a 10× multiplier.
- BUCK-R17 remains a deferred implementation obligation. The experiment resolves
  feasibility for its Linux surface, not every admitted platform or action.

## Evidence

- [Protocol and worker probes](../.experiments/2026-09-30-namespace-remote-execution.md#protocol-and-worker-probes)
- [Real-graph bakeoff](../.experiments/2026-09-30-namespace-remote-execution.md#real-graph-bakeoff)
- [Fair-concurrency benchmark](../.experiments/2026-09-30-namespace-remote-execution.md#fair-concurrency-benchmark)
- [Trust experiments](../.experiments/2026-09-30-namespace-remote-execution.md#trust-experiments)
- [Complexity and economics](../.experiments/2026-09-30-namespace-remote-execution.md#total-complexity-and-economics)
- [Prior NativeLink attempt](../.experiments/2026-09-19-nativelink-remote-execution.md)
