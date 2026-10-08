# 0033 CI Cache Posture: Two Trust Tiers

Status: accepted

## Context

Public repositories run pull-request CI on Namespace runners. A public pull
request can execute untrusted code and must not receive cache write authority or
access to private-repository artifacts. Private repositories stay on
self-hosted tailnet runners inside the single-operator BUCK-A05 trust boundary.
The current fleet cache is tailnet-only, read-write, and shared across
repositories; `instance_name` is attribution rather than full isolation.

Force-cold public CI does not meet the reuse and wall-clock budgets. The measured
failure is retained in
[the experiment](../04-buck2/06-reuse-client/.experiments/2026-09-12-ci-cache-posture.md).

## Evidence and Argument

- Johannes accepted the two-tier cache posture in q16 on 2026-09-12, with the
  BUCK-R06/REUSE-R01 refinement recorded below as a required follow-up.

Buck2 independently controls remote-cache reads and uploads. A public pull
request can set `remote_cache_enabled = True` and `allow_cache_uploads = False`,
but the server must enforce the write denial. bazel-remote v2.6.2 can require
authentication for writes while allowing unauthenticated reads. It cannot fully
isolate tenants in one process: optional instance mangling applies to action
cache entries, while CAS and ByteStream ignore the instance name.

Tailscale solves transport, not trust. Giving untrusted code a tailnet tag does
not make that code trusted, and the current cache endpoint has no reader/writer
role split. Namespace's managed Bazel cache is a plausible REAPI alternative,
but Namespace does not document Buck2 support or a branch-based writer policy;
no interoperability result exists.

## Options

| Option                                                        | Tradeoff                                                                                                                  | Outcome                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Put every Namespace job on the tailnet                        | Reuses the existing cache, but grants public PR code tailnet reachability and current read-write cache access             | Rejected                |
| Expose the existing shared cache publicly with authentication | Small service delta, but public readers could address private CAS blobs and PRs cannot safely receive a static credential | Rejected                |
| Use Namespace Cache Volumes for `buck-out`                    | Branch-protected writes and fast local storage, but no REAPI or reliable cross-machine action reuse                       | Rejected                |
| Use Namespace's managed Bazel cache                           | Short-lived credentials and low latency, but Buck2 compatibility and PR write denial are unverified paid features         | Deferred bakeoff        |
| Add a separate public-repository bazel-remote tier            | Known Buck2 protocol; unauthenticated reads plus authenticated writes; separate storage preserves confidentiality         | Recommended             |
| Keep public PRs force-cold                                    | Safe and available now, but retains the measured ENOSPC and latency failure                                               | Temporary fallback only |

## Decision

Use two cache trust domains:

1. Public repositories use a dedicated public-repository bazel-remote process,
   TLS, and a separate data directory. The server permits unauthenticated reads
   and requires authentication for writes. Public pull requests omit credentials
   and set `allow_cache_uploads = False`. Protected `main` jobs receive the write
   credential and set `allow_cache_uploads = True`.
2. Private repositories keep the tailnet-only cache. Private pull-request and
   main jobs read and write because their authors and runners remain inside
   BUCK-A05.
3. Each repository retains its own `instance_name` for attribution and optional
   action-cache mangling. No policy treats it as CAS isolation.
4. Every lane retains the explicit local-only escape hatch. The pinned Buck2 can
   fail during initial remote-client setup, so automatic universal fail-open is
   not assumed.
5. Namespace's managed Bazel cache can replace the public tier only after a
   branch-only spike proves Buck2 AC/CAS/TLS compatibility, unchanged-head hits,
   main-only writes, and outage behavior.

## Consequences

- Untrusted public pull requests benefit from results written by protected main
  without receiving a credential or publication authority.
- Public cache contents are intentionally readable by digest and must contain
  public-repository artifacts only.
- The service fleet gains one process, listener, bounded storage directory,
  credential, health check, and cache metric identity.
- Follow-up: refine BUCK-R06 and REUSE-R01 so untrusted public pull requests
  are read-only, then align REUSE-A01, REUSE-R06, the root and reuse specs, the
  roadmap, and materialization DQ1 with the accepted two-tier topology.
- CI remains force-cold until the public tier exists and a Namespace lane proves
  the exact client contract.

## Amendment — 2026-09-24

Johannes confirmed that trust tier follows **repository visibility**, not the
`private` field of an npm package manifest. In public effect-utils,
`"private": true` expresses the intent not to publish to npm; it does not
classify the package or its Buck product as confidential. All effect-utils
products built exclusively from this public repository and public dependency
inputs belong to the public tier. Publication still refuses source paths
outside the repository and private-repository dependency inputs.

## Amendment — Protected queue and main gating writers

Johannes chose maximum public-cache reuse in q10/q11/q14 and q31. Heavy gate
lanes publish Buck results on native `merge_group` heads targeting protected
main and on fallback main pushes. The credential is step-local: its expression
requires either a push to `refs/heads/main`, or a `merge_group` whose base is
`refs/heads/main` and whose ref is under `refs/heads/gh-readonly-queue/main/`.
Pull-request events never receive the credential, including same-repository PRs.
The workflow cache policy admits only this exact guarded expression.

These opportunistic writers set `BUCK2_CACHE_WRITE_OPTIONAL=1`: if the bounded
REAPI preflight cannot reach the cache, they warn and execute locally with remote
cache reads and uploads disabled. A cache outage must not make the main gate red.
The dedicated trusted remote-cache proof does not set this flag and remains
fail-closed. This preflight fallback is not a guarantee against an outage that
starts after a successful probe.

Preflight failures emit a fixed error class (configuration, DNS, TCP, TLS,
transport, deadline, authentication, HTTP, gRPC, or protocol), the configuration,
DNS, TCP, TLS, or response phase, elapsed milliseconds, and the configured deadline.
Socket events record DNS-resolved candidates, TCP attempts/connections, and TLS
readiness with monotonic elapsed time, public IP addresses, and address families.
Private, tailnet, local, and IPv4-mapped IPv6 addresses are redacted. Endpoint
names, credentials, certificates, and server-provided error text never enter
diagnostics. These events observe the existing socket without replacing DNS
resolution, address selection, or transport settings.
Each cache endpoint gets 2500 ms per attempt, including connection setup, and
exactly one immediate retry after a failed first attempt: at most 5000 ms total
probing per endpoint. REAPI and archive-origin probes run concurrently. Only
failure of both attempts triggers the existing warning and fallback; required
writers remain fail-closed after both REAPI attempts fail. Watchman's independent
fail-closed root admission is defined in the [reuse-client specification](../04-buck2/06-reuse-client/spec.md#direct-invocation-admission-buildbuckreuse-r04).
A deadline does not by itself establish a
cache-server outage. A five-second endpoint-result cache can reuse a failure;
its original probe emits diagnostics rather than repeating them on cache hits.

In [merge-group run 37557021971](https://github.com/overengineeringstudio/effect-utils/actions/runs/37557021971)
(PR #1578, 01:25Z), four macOS Namespace test invocations fell back, as did one
`pr/quality` invocation. The subsequent
[Namespace vantage run 37575934824](https://github.com/overengineeringstudio/effect-utils/actions/runs/37575934824)
(05:22–05:32Z, 600 seconds per platform) isolated the dominant Namespace stall
to TLS, not lost SYNs: TCP connect exceeded 900 ms in 0/138 Linux and 0/141 macOS
samples, while TLS exceeded 900 ms in 8.0% of Linux samples (p99 1696 ms) and
14.2% of macOS samples (p99 1467 ms). An independent clean control had 0/660
bad samples. The 2500 ms attempt deadline covers both measured TLS p99 values;
per-phase diagnostics remain essential to distinguish transport causes.

Lost-SYN recovery is a secondary rationale: the old 900 ms whole-invocation
deadline ended before the roughly one-second initial TCP retransmission timeout,
so around 1% path loss could become fallback instead of a recovered connection.
The immediate retry gives a failed connection a second bounded attempt. Earlier
transport evidence likewise did not implicate the cache service: an independent
clean vantage to the service through Funnel had zero bad samples out of 879.
The earlier 7–9% stall observation came from a lossy client uplink, not the
cache service, and does not explain the Namespace TLS measurements.

Main pushes compare their Git tree with recent protected-main merge-group heads.
Heavy lanes skip only when every required context succeeded on that same head,
using each workflow's latest run attempt. Missing, failed, mismatched or
unavailable evidence runs the heavy lanes. Publishers, empirical proofs and the
strict trusted remote-cache proof do not depend on this skip decision.

## Amendment — Namespace Compatibility and Reader Authorization

Accepted 2026-09-30 by Johannes (q2, q5, q6).

The [Namespace compatibility spike](../.experiments/2026-09-30-namespace-remote-execution.md)
proves Buck2 AC/CAS/TLS and real Linux RE with plain `host:443` addresses and
`tls = true`; unchanged-head hits after `clean` are proven. The tested CLI also
provides `nsc reapi setup buck2`. This supersedes the interoperability uncertainty
above, not the public-tier trust gate.

Main-only writes are **not enforceable with the tested setup**. The bearer from
`--storage=read-only` can update the AC and execute after switching to RW
storage/scheduler endpoints. User/tenant token scope does not attenuate it.
Different `--key` clusters share AC hits; keys are not isolation.

The public tier therefore stays on self-hosted bazel-remote. Replacement is
deferred until a non-escalatable reader and branch-scoped writer identity pass
the escalation rerun and the remaining reuse/outage gates.
[Decision 0039](./0039-namespace-first-remote-candidate-adoption-deferred.md)
records the cache-first re-entry tracks and retargets Phase 7 to Namespace.

## Dotfiles lead brief

Target: add a public-repository Buck2 cache tier; do not alter the private cache.

- Run a second bazel-remote process with its own bounded data directory.
- Expose gRPC through TLS 1.2 or newer on a stable public endpoint.
- Enable Basic or mTLS authentication and `allow_unauthenticated_reads`.
- Keep all private-repository cache data on the tailnet-only process.
- Retain per-repository instance names; treat action-cache mangling as optional
  attribution isolation, never CAS isolation.
- Create one write credential for protected public-repository main lanes.
- Declare that credential through the existing SecretSpec/1Password inventory;
  do not place its value or locator in effect-utils.
- Add health, capacity, eviction, read, write, and auth-failure metrics/alerts.
- Verify unauthenticated read succeeds, unauthenticated write fails, authenticated
  write succeeds, and neither endpoint can read the other's seeded CAS blob.
- Return the public endpoint, CA contract, credential environment name, and
  rollback command to the effect-utils owner for the dispatch-only CI proof.

## Amendment 1 — Mitigated Tailnet Cache Writers

Axe record `4pmebr` permits any tailnet context to write the shared cache with
mitigations; it supersedes blanket network-trust and protected-publisher-only
write interpretations above, without exposing private CAS to public readers.

Only audited hermetic lanes publish: scrubbed environments, declared exact tools
and inputs, and actual sandbox enforcement where feasible. Host-dependent lanes
neither read nor write; flaky tests are uncached. Enable AC key instance mangling
per repository; CAS remains shared inside its trust domain. Revocable per-host
write credentials and authenticated logged action keys support a purge runbook:
revoke/quarantine writer, identify keys, stop the cache, remove matching AC files,
restart and cold rebuild. Instance-generation rotation works only with mangling.
Keep digest/dependency validation on, but do not confuse it with producer trust.
Public PRs remain read-only, enforced server-side rather than by client flags alone.

[Execution admission](../04-buck2/05-execution/spec.md#cache-writable-lane-admission)
owns lane eligibility. Consumer policy/service realization owns authorization,
credentials, key logs and purge operations. Mitigation design and enforcement
remain explicit owning DQs; this amendment does not claim controls are implemented.
Historical BUCK-A05 and REUSE-R01/R06 resolve through the [ID map](../.reference/id-map.md).
