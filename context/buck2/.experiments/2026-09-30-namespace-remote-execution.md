# Namespace Remote Execution with Buck2

Date: 2026-09-30
Real-graph revision: `3ab9d858ad171fd4cbaebcb58bff35f927e53bc2`
Probe: Buck2 2026-08-22; nsc 0.0.567; Linux x86_64 client.
Real graph: repository-pinned Buck2 `2026-08-31-be6971d47dcc835b7356e1698b23039ffee4f4c2`.

## Question

Can Namespace execute the real Buck2 graph with exact Nix tool closures and
unchanged-head cache reuse? Does adoption reduce total complexity across
repositories, fleet configuration, worker provisioning, credentials, and
operations enough to justify replacing the public cache or local execution?

## Method

1. Use the prelude-less [probe kit](./2026-09-30-namespace-remote-execution/BUCK.fixture)
   with a remote-only executor. Obtain endpoints through `nsc bazel setup
   --static -o json`; use plain `host:443`, TLS, and bearer expansion in the
   Buck daemon environment. Compare a remote input hash with local `sha256sum`,
   clean Buck state, and repeat. Probe default Linux/Darwin workers and named
   pools whose startup scripts realize Nix paths before registration.
2. In isolated clones, apply the [five-file opt-in patch](./2026-09-30-namespace-remote-execution/remote-execution.patch).
   Run content-address typecheck, emit, and unit tests, then `//:quick` locally,
   remotely, after clean, and after a source-comment edit. Record Buck event
   logs, `what-ran`, action counts, transport, and emit bytes. Stop each owned
   daemon and destroy owned clients/workers; do not mutate canonical checkouts.
3. Rerun clean `//:quick` at fair concurrency on an eight-core 8x16 client:
   local `-j 8`, remote `-j 64`, RE execution semaphore 32. Each row starts with
   `clean`; local rows disable cache/uploads. Use a fresh pool for cold RE,
   then clean-client AC reuse and same-pool `--no-remote-cache` execution.
   The client and workers were in different regions. Shared CAS was not empty.
4. Test read-only setup, endpoint switching, direct AC update and scheduler
   execution, cross-key AC reuse, and user/tenant token revocation. Keep bearer
   values out of configs, action environments, and evidence.
5. Inventory integration surfaces and infrastructure ownership. Surface counts
   describe maintained responsibilities, not files or deployed changes.

Source reports: `REPORT.md`, `InfraBoundaryMap.md`, `TrustTierReview.md`,
`EconomicsLockin.md`, `RealGraphBakeoff.md`, `FairConcurrencyBench.md`, and
`ComplexityLeakMap.md` from the probe findings. This record preserves their
measured results and limits, not their earlier adoption recommendations.
Large JSON and evidence archives are not checked in.

## Result

### Protocol and worker probes

| Probe | Worker preparation | Result | Wall |
| --- | --- | --- | ---: |
| `//:env`, `//:hash` | Default Linux | 2 remote actions; hash matches local bytes | 6 s |
| Same after `clean` | Default Linux | 100% AC hits; 0 remote commands | <1 s |
| `//:nix_hello` | Linux Nix startup pool | Absolute `/nix/store` executable runs | 14 s cold |
| `//:env` | Default macOS arm64 | Darwin 25.3, arm64 | 17 s |
| `//:nix_hello` | Darwin Nix startup pool | Absolute Darwin `/nix/store` executable runs | 75 s cold |
| `//:caps_tools` | Linux capability pool, 212 tool-closure paths / 3.35 GiB | `tsgo`, `bun`, `rustc`, `node` run remotely | 22 s cold |

AC, CAS, TLS, and RE work without a Buck2 protocol change. Buck2 rejects a
`https://` address; it accepts plain `host:443` with `tls = true`.
`nsc reapi setup buck2` also exists in the tested CLI. Default workers have no
Nix store. Named pools realize the closure before registration; pool properties
enter the REAPI action digest. Startup-script pools require
`namespace_action_isolation = none`; macOS has no per-action isolation.

### Real-graph bakeoff

The initial matrix used `-j 2`, which limits local execution, not the RE
semaphore. Remote workers autoscaled to four 8x16 instances. Package and test
steps preceded quick in each stage, so these quick counts are not the counts
of a direct clean quick invocation.

| Stage | Surface | Wall, s | Remote | Local | AC hits |
| --- | --- | ---: | ---: | ---: | ---: |
| Local, cache disabled | Typecheck + emit | 4.808 | 0 | 193 | 0 |
| Local | Unit test | 0.555 | 0 | 1 | 0 |
| Local | Quick after package/test | 41.481 | 0 | 1,083 | 0 |
| Fresh pool, cold action keys | Typecheck + emit | 58.331 | 193 | 0 | 0 |
| Fresh pool | Unit test | 3.482 | 1 | 0 | 0 |
| Fresh pool | Quick after package/test | 136.778 | 1,070 | 13 | 0 |
| After clean | Typecheck + emit | 2.387 | 0 | 0 | 193 |
| After clean | Unit test | 0.769 | 0 | 0 | 1 |
| After clean | Quick after package/test | 3.955 | 0 | 0 | 1,083 |
| Source-comment edit | Typecheck + emit | 9.338 | 3 | 0 | 0 |
| Source-comment edit | Unit test | 3.265 | 1 | 0 | 0 |
| Source-comment edit | Quick after package/test | 66.452 | 81 | 6 | 0 |

- All reached rows succeeded. The package test passed 18 tests remotely,
  including after the edit. `//:quick` is not proof that every unit-test lane ran.
- Emit output matched byte-for-byte: 12 files, 105,933 content bytes; manifest
  SHA-256 `d655f7be8b74ae258555413675567b6389196a43ba7f5dc9f06182af44946a27`.
- The real worker needs all 212 tool-closure paths **plus the capability
  projection root**. The complete closure measured 3,609,396,880 bytes.
  `.buck2/capabilities` must link directly to the immutable store root, not a
  checkout-specific alias such as `/root/caps`. Realizing the root alone did
  not fix that alias. Early hybrid runs concealed this error through fallback;
  only the final zero-local package/test rows prove their remote execution.
- Tests require project-root execution, project-relative paths, and
  `--unstable-allow-compatible-tests-on-re`.
- Thirteen quick actions remained intentionally local: policy/validation,
  Weaver, product assembly, package-bin extraction, format/lint, and server
  validation. Remote intermediate outputs still materialize for these consumers.
- Real Darwin graph execution was not reached. The pinned Darwin projection
  required 409 derivations and stopped at a Darwin-only build prerequisite on
  Linux. The synthetic Darwin hello does not prove this closure is substitutable.

### Fair-concurrency benchmark

Every row started directly at clean `//:quick` and analyzed 2,428 targets.
The 1,276 command actions comprise 1,263 remote-eligible and 13 local-only
commands; 918 other actions are excluded. Four workers supplied 16 remote
slots cold; five supplied 20 warm. The client budget was 32 outstanding RE
requests, not a server-side eight-worker cap. Peak actual worker commands were
6 cold / 9 warm; client Execute peaks were 16 / 20.

| Row | Wall, s | Local | Remote | AC hits | Relative to local mean |
| --- | ---: | ---: | ---: | ---: | ---: |
| Local cold 1, 8 slots | 34.668 | 1,276 | 0 | 0 | — |
| Local cold 2, 8 slots | 36.053 | 1,276 | 0 | 0 | — |
| RE cold, fresh pool | 235.276 | 13 | 1,263 | 0 | 6.65× |
| RE clean-client AC reuse | 5.105 | 0 | 0 | 1,276 | 0.14× |
| RE warm workers, AC bypassed | 130.680 | 13 | 1,263 | 0 | 3.70× |

Local mean was 35.360 s. Cold means cold workers and action keys, not virgin
CAS. Warm execution bypassed AC reads, server cache lookup, and writes, but
retained worker/tool/CAS state; a fifth worker also booted during that row.
Two local samples and one sample per remote posture do not establish a general
provider speed ranking.

| Attribution | Cold RE | Warm-worker RE |
| --- | ---: | ---: |
| Median actual command | 11.790 ms | 11.221 ms |
| Median client `Re/Execute` stage | 127.644 ms | 132.355 ms |
| Summed server queue time | 1,994.420 s | 301.018 s |
| Summed actual command execution | 95.123 s | 87.836 s |
| RE downloads | 700,238,932 bytes | 699,203,001 bytes |
| Materialized output | 69,786 files / 1,000,603,375 bytes | Same |

The cold graph had 561 archive extractions and 547 normalized store-entry
commands. These roughly 1,100 tiny actions consumed only 17.171 summed worker
command seconds, but each remote operation carried about 130 ms of lifecycle
cost. That stage includes hydration, output handling, scheduler completion, and
transport; pure network RTT was not isolated. Worker boot took 16–25 s,
approximately 20 s, and capacity ramped over 88.7 s. Warm workers did not remove
the latency penalty. Roughly 670 MiB of client downloads and local consumers
remain. Parallel sums overlap and must not be added to recover wall time.

TypeScript commands consumed less summed execution time remotely, but their
phase expanded from about 29 s local to 155 s cold RE / 106 s warm RE.
[INFERENCE] Dependency-ordered progression amplifies per-hop overhead; no
retained critical-path reconstruction assigns an exact fraction to it.

### Trust experiments

| Experiment | Observed result | Boundary conclusion |
| --- | --- | --- |
| RW seeded action; clean; RO endpoint read | 1 AC hit / 0 remote, 1.266 s | Reads work |
| RO endpoint uncached action | Upload denied, `PERMISSION_DENIED`, 1.366 s | Endpoint denies uploads, not proof of worker execution |
| Same RO setup bearer; switch to RW storage/scheduler | Uncached action executes remotely, 2.407 s | Bearer is not reader-only |
| Direct RO `UpdateActionResult` | Denied | Endpoint restriction works |
| Same bearer, RW `UpdateActionResult` with identical result | Accepted | Reader bearer escalates to AC write authority |
| Same bearer, scheduler `Execute`, skip cache | Accepted, 3 operation messages | Reader bearer escalates to execution; separate build proves execution |
| Unique action on key A, clean, key B | A: 1 remote, 5.574 s; B: 1 AC hit, 1.265 s | `--key` does not isolate AC |
| User/tenant tokens with 15-minute expiry | Both grant execution/storage writes; RO setup forwards same bearer | Membership scope is not a reader role |
| Revoke both created tokens, retry setup | Both rejected as revoked | Revocation works |

RO and RW interactive setup returned the same bearer. The test updated an
existing identical ActionResult, not poisoned content. Arbitrary cross-key CAS
access and cross-workspace AC/CAS isolation were not measured. OIDC federation
was documentation research only, not a proved protected-main writer policy.
Untrusted jobs must not receive the tested bearer or a broader replacement
workload identity. Startup-script/direct workers cannot mix trusted and
untrusted work; private artifacts and secret-bearing actions remain outside the
public execution domain.

### Total complexity and economics

| Stage | Surfaces touched | Persistent integration burden | Machinery removed after proof |
| --- | ---: | --- | --- |
| S1 public shared cache | 14 | Endpoint/root rendering, posture, CI auth, server denial/outage proof, onboarding, workspace/federation/billing, fleet retirement | Public bazel-remote process, storage, auth, ingress, activation, public-only monitoring |
| S2 Linux RE | +10 touched; 18 distinct cumulative | Platform/test routing, action portability, complete closure publication, immutable pool lifecycle/GC, invocation flags, quota and native evidence | No additional deployed machinery; avoids proposed public NativeLink scheduler/workers |
| S3 macOS RE | +5 touched; 19 distinct cumulative | Darwin capability publication, OS-specific startup/routing, trusted-only workers, selected jobs and spend limits | No additional deployed machinery |

The increments count stage-touched groups, including groups modified again;
they are not 10 and 5 entirely new surfaces. The measured prototype is five
files, +59/−23 lines; production auth, pool lifecycle, consumer pin/config,
CI callers, and fleet retirement are outside that patch. LOC estimates in the
source inventory are not measured implementation savings.

Nix/Cachix remains the capability and product-distribution authority. Private
cache/storage/auth, native builders, local admission/locks, CI orchestrators,
and Buck-native observability remain. RE workers do not replace GitHub runners.
The inventory found no tracked Buck graph in LiveStore or the 11 accessible
compoundingtech directory identities; future consumers need explicit admission,
not automatic endpoint inheritance. Dotfiles is an existing private consumer.

Published pricing at the time was $0.10/1,000 AC hits, $0.20/GB-month CAS, and a
10× macOS compute multiplier ([pricing](https://namespace.so/pricing)). Exact
RE invoice pricing and traffic terms need confirmation. The fair benchmark
used 63.312 8x16 shape-minutes / 506.499 compute unit-minutes including setup,
evidence, and idle time; the earlier bakeoff used 92.632 shape-minutes /
741.059 unit-minutes. These are resource lifetimes, not invoices or total-cost
savings. Earlier modeled adoption advice is superseded by the fair benchmark
and Johannes's deferral decision.

## Falsifiers

- A missing tool/projection path, hidden local fallback in an admitted remote
  command, or unequal output bytes falsifies its worker capability proof.
- A changed input returning the old result, or an unchanged post-clean action
  executing again, falsifies the tested identity/reuse expectation.
- Any reader endpoint-switch, RW setup, token-mint, AC/CAS write, or scheduler
  escape falsifies reader attenuation. The tested setup already fails this gate.
- A fair rerun that remains slower after tiny actions are local/coarsened
  falsifies the Linux cold-latency case. Runner-capacity adoption needs measured
  public CI queueing, not assumed host load.
- An unsubstitutable Darwin closure or no named Darwin workload falsifies macOS
  re-entry. No synthetic probe substitutes for real-graph proof.

## Conclusion

Protocol, Linux real-graph execution, emit identity, and clean-client reuse are
proven for the measured revision. Remote-by-default cold execution is not a
speed improvement: cold RE was 6.65× slower, and warm-worker execution still
3.70× slower. Reader authorization blocks public-cache replacement. Assess the
total recurring integration surface, not only managed versus self-hosted cost.
Defer rollout; keep Namespace as the first candidate with cache-first re-entry.

Operational state retained by Johannes's q4 decision: dev3 `nsc login` and the
`buck2-probe` cluster remain. Owned benchmark clients/workers were destroyed;
created review tokens were revoked. This retained login/cluster is experiment
state, not a deployment requirement or rollout approval.

## Intent Impact

- [Decision 0039](../.decisions/0039-namespace-first-remote-candidate-adoption-deferred.md)
  records deferral and the three re-entry tracks; decisions 0013 and 0037 retain
  their NativeLink history.
- [Decision 0033 Amendment 1](../.decisions/0033-ci-cache-posture-two-trust-tiers.md#amendment-1)
  records interoperability and failed reader attenuation; the public cache stays
  on self-hosted bazel-remote.
- [Phase 7](../roadmap.md)
  targets Namespace conditionally and deletes only public cache machinery after
  Track A completes.
- [Execution spec](../02-execution/spec.md) records the realized closure/pool and
  test mechanism; [execution findings](../02-execution/open-questions.md) answer
  worker realization and retain the per-action overhead evidence. No vision or
  requirement changes.
