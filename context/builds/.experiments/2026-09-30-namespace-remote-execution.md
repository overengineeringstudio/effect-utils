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

### Reproduction recipe and retained reducer inputs

The following is a **future reproduction recipe**, not a rerun performed during
the October review repair. It requires an approved, public-only Namespace
workspace, an authenticated `nsc`, Linux x86-64, Nix, jq, and permission/budget
for an ephemeral client and workers. No Namespace login or CLI is available on
the review host. Never run the authorization probes against private workloads,
give their credentials to fork code, or commit setup JSON, overlays or raw logs.
Use private scratch directories, `umask 077`, and no shell tracing.

#### Historical graph preparation

The five-file patch targets the revision below, **not current main**. Set `KIT`
to the absolute directory containing this experiment's checked-in files and
`SCRATCH` to a new private directory outside every checkout:

```sh
umask 077
export KIT=/absolute/path/to/context/builds/.experiments/2026-09-30-namespace-remote-execution
export SCRATCH=/absolute/private/scratch
mkdir -p "$SCRATCH"
git clone https://github.com/overengineeringstudio/effect-utils.git "$SCRATCH/graph"
cd "$SCRATCH/graph"
git checkout --detach 3ab9d858ad171fd4cbaebcb58bff35f927e53bc2
export NIX_REMOTE=local
# Realize capabilities BEFORE applying the patch: dirty flake inputs change projection identity.
nix build .#buck2-capabilities --out-link "$SCRATCH/caps" --print-out-paths
nix build --impure --expr "
  let f = builtins.getFlake (toString $PWD);
      pkgs = import f.inputs.nixpkgs { system = \"x86_64-linux\"; };
  in import $PWD/nix/buck2.nix { inherit pkgs; }
" --out-link "$SCRATCH/buck" --print-out-paths
export BUCK2="$SCRATCH/buck/bin/buck2"
"$BUCK2" --version
mkdir -p .buck2
ln -sfn "$(readlink -f "$SCRATCH/caps")" .buck2/capabilities
git apply "$KIT/remote-execution.patch"
```

Recorded binary: `2026-08-31-be6971d47dcc835b7356e1698b23039ffee4f4c2`.
Recorded projection: `/nix/store/jy71x8qqsdx6kvmax1bcfip111zc2gkj-buck2-capabilities`,
generation `83ecff46b76ac347deebc349a7e453220e9bd6cb635a1dfc24ca11bfcd4927f8`.
Do not substitute an alias such as `.buck2/capabilities -> /root/caps`: exported
manifest paths must resolve to the immutable store root on workers.

Publication is a prerequisite, not an action-time fetch of arbitrary tools.
The recorded projection and its 212 manifest tool-closure paths were already
substitutable from the public Nix caches. If reproducing with a newly realized
projection, a trusted publisher must publish its full closure, including the
projection root, to the public capability cache before starting workers:

```sh
# Trusted publisher only; use its existing approved Cachix identity, never a token literal.
cachix push overeng-effect-utils "$(readlink -f "$SCRATCH/caps")"
nix path-info --closure-size "$(readlink -f "$SCRATCH/caps")"
jq -rs '[.[].closureStorePaths[]]|unique|length' "$SCRATCH/caps"/generations/*/*/*/manifest.json
```

The patch's worker startup installs Nix and realizes the manifest paths **plus
the projection root**, using the documented public Cachix key. It sets
`namespace_action_isolation=none`; these are trusted-only workers, not a fork
sandbox contract. A changed closure/startup definition requires a new pool.

#### Placement, lifecycle and complete matrix

Recorded placement was an **8x16 client in `ord4`**, scheduler/storage and
**8x16 workers in `iad4`**. It was not colocated. Reproduce that pair using the
approved workspace's region selection before creating the client/RE cluster;
inspect the resulting inventory rather than assuming default placement:

```sh
nsc create --bare --ephemeral --duration 40m --machine_type linux/amd64:8x16 \
  --purpose 'public historical fair-concurrency reproduction'
nsc bazel setup --static --key="$NS_KEY" -o json > "$SCRATCH/setup.json"
export NS_SETUP_FILE="$SCRATCH/setup.json"
export NS_POOL="fair-concurrency-$(date +%Y%m%d%H%M%S)"
export EVIDENCE_DIR="$SCRATCH/evidence"
nsc list --all -o json > "$SCRATCH/inventory-before.json"
# In the prepared isolated checkout on that client:
bash "$KIT/real-graph-run.sh" local L-cold-1
bash "$KIT/real-graph-run.sh" local L-cold-2
bash "$KIT/real-graph-run.sh" remote R-cold
bash "$KIT/real-graph-run.sh" remote R-clean
bash "$KIT/real-graph-run.sh" remote-warm R-warm-workers
```

Set `NS_KEY` to an approved execution cluster key; the recorded run reused
`buck2-probe` with a **new** pool, so shared CAS was not virgin. Cold means no
existing workers with that exact pool label and no AC hits in the cold row.
Keep the cold workers alive through both following rows: clean-client AC reuse
then same-pool warm-worker execution. Do not destroy/recreate the pool between
them. Every driver invocation cleans its isolated daemon before timing the
build; clean/setup/evidence extraction are excluded from build wall time.

The driver includes the complete local (`-j 8 --local-only`, reads/uploads off)
and remote (`-j 64 --prefer-remote`, RE semaphore 32, TLS, reads/uploads on)
invocations and native evidence capture. Warm uses **`--no-remote-cache`**:
it disables client AC reads, server Execute cache lookup **and AC writes**.
CAS deduplication remains active; zero warm input-blob uploads is not AC reuse.
The 13 explicitly local-only actions remain local, not hidden fallback.

Monitor exact pool-label inventory during cold/warm execution. The recorded
eight-worker stop guard was operational, **not a per-pool server hard cap**:
the shared scheduler advertised max_workers 15, workers advertised four slots
each, and actual autoscaling reached four cold / five warm (four initially
ready). A 32-request budget does not prove eight workers were provisioned.
Stop the build if the approved eight-worker ceiling is crossed. Save owned IDs
and readiness/startup times privately; never destroy a borrowed cluster:

```sh
"$BUCK2" --isolation-dir fairconcurrency kill
rm -f .buckconfig.local "$NS_SETUP_FILE"
# Repeat for each owned client/worker ID, selected by exact client identity/pool label:
nsc destroy --force "$OWNED_INSTANCE_ID"
nsc list --all -o json > "$SCRATCH/inventory-after.json"
nsc instance history --all --since 1h --max_entries 1000 -o json > "$SCRATCH/history.json"
```

#### Evidence capture and reduction

The driver saves each row's exit status and start/end in `times.tsv`, explicit
protobuf event log, native `log summary`, `log what-ran --format json`, and
`log show` JSON. Keep these private. The checked-in
[sanitized aggregate inputs](./2026-09-30-namespace-remote-execution/fair-measurements.json)
retain the five rows, action counts, category sums, overlap peaks, upload,
download and materialization totals without absolute timestamps, tenant
endpoints, instance identities or credentials:

```sh
python3 "$KIT/reduce-fair.py" "$KIT/fair-measurements.json"
```

This stdlib reducer reproduces the **recorded aggregate** comparison, not the
raw-event extraction. For fresh measurements, reduce build wall as end minus
start (require exit 0), counts from native summary/what-ran, uploads from
`ReUpload.bytes_uploaded`, materialization from successful `Materialization`,
and downloads from the final fresh-daemon snapshot. Reconstruct worker-command
overlap from non-cache command `start_time + execution_time_us`; reconstruct
client peaks separately from event spans. Exclude AC-hit historical execution
metadata. Category sums, queue sums and spans overlap: never add them to
reconstruct wall time or label the residual pure network RTT.

The retained original archive is `FairConcurrencyBench.evidence.tar.gz`,
15,670,642 bytes, SHA-256
`95a81c06136c3c2a843a95b9d162d4200439d5598322826f781305ae7e578716`.
It is a private retained artifact, **not a public/downloadable evidence link**.
The sanitized inputs substantiate the core matrix and attribution without
publishing raw evidence; independently verifying event extraction still
requires that archive. Samples remain two local, one cold RE, one warm-worker
RE and one clean-client cache row, not statistical or general speed evidence.

#### Authorization escalation and cross-key reproduction

Only in an approved public-only disposable trust probe, capture setup output
in 0600 scratch files. `--storage=read-only` also requires `--remote=false`:

```sh
nsc bazel setup --static --key="$KEY_A" --storage=read-write -o json > "$SCRATCH/rw-a.json"
nsc bazel setup --static --key="$KEY_B" --storage=read-write -o json > "$SCRATCH/rw-b.json"
nsc bazel setup --static --remote=false --key="$KEY_A" --storage=read-only -o json > "$SCRATCH/ro-a.json"
export NS_RW_FILE="$SCRATCH/rw-a.json" NS_RO_FILE="$SCRATCH/ro-a.json"
# Digest of an already uploaded, harmless, uniquely salted probe action:
export ACTION_HASH="$SEEDED_ACTION_SHA256" ACTION_SIZE="$SEEDED_ACTION_SIZE"
# Reuse the historical graph's pinned nixpkgs, not a global Python install:
nix build --impure --expr "
  let f = builtins.getFlake (toString $SCRATCH/graph);
      pkgs = import f.inputs.nixpkgs { system = \"x86_64-linux\"; };
  in pkgs.python3.withPackages (ps: [ ps.grpcio ])
" --out-link "$SCRATCH/rpc-python"
"$SCRATCH/rpc-python/bin/python3" "$KIT/auth-rpc.py" > "$SCRATCH/rpc-status.jsonl"
```

The [parameterized RPC probe](./2026-09-30-namespace-remote-execution/auth-rpc.py)
replays standard REAPI GetActionResult, identical-result UpdateActionResult
against RO then RW endpoints using the **same RO bearer**, and Execute with
`skip_cache_lookup=true` against RO storage then the RW scheduler. It never
prints response bodies/error details. Stream acceptance is not final worker
success; use a separate uncached Buck build to prove actual execution.

For the Buck cross-key and uncached escalation checks, prepare an isolated
probe project and use fresh public salts, unchanged across A/B. The tiny
authorization probe historically used Buck2 2026-08-22, not the real-graph pin.
Set `PROBE_BUCK2` to that binary to match its historical contract.

```sh
export NS_PROBE_DIR="$SCRATCH/trust-project" NS_KEY="$KEY_A" BUCK2="$PROBE_BUCK2"
export XDG_RUNTIME_DIR="$SCRATCH"
bash "$KIT/run.sh" --help >/dev/null
cd "$NS_PROBE_DIR"
SALT=$(date +%s%N)
cat >> BUCK <<EOF
probe(name = "trust_unique", argv = ["/bin/sh", "-c", "printf '$SALT-a' > \\"\$1\\"", "--"])
probe(name = "trust_readonly_miss", argv = ["/bin/sh", "-c", "printf '$SALT-b' > \\"\$1\\"", "--"])
EOF
# Select storage, scheduler, and bearer independently; never print bearer values.
select_auth() {
  "$PROBE_BUCK2" kill
  export NS_RE_TOKEN
  NS_RE_TOKEN=$(jq -r .ingress_auth_token "$3")
  {
    printf '[buck2_re_client]\n'
    jq -r '"  engine_address = " + (.scheduler_endpoint|sub("^grpcs://";""))' "$2"
    jq -r '"  action_cache_address = " + (.storage_endpoint|sub("^grpcs://";"")), "  cas_address = " + (.storage_endpoint|sub("^grpcs://";""))' "$1"
  } > .buckconfig.local
  "$PROBE_BUCK2" clean
}
select_auth "$SCRATCH/rw-a.json" "$SCRATCH/rw-a.json" "$SCRATCH/rw-a.json"
"$PROBE_BUCK2" build //:trust_unique --show-output
select_auth "$SCRATCH/ro-a.json" "$SCRATCH/rw-a.json" "$SCRATCH/ro-a.json"
"$PROBE_BUCK2" build //:trust_unique --show-output
"$PROBE_BUCK2" clean
if "$PROBE_BUCK2" build //:trust_readonly_miss --show-output; then
  printf 'Unexpected RO miss success: inspect execution evidence\n'
else
  printf 'RO miss failed with exit %s: inspect upload denial evidence\n' "$?"
fi
select_auth "$SCRATCH/rw-a.json" "$SCRATCH/rw-a.json" "$SCRATCH/ro-a.json"
"$PROBE_BUCK2" build //:trust_readonly_miss --show-output
select_auth "$SCRATCH/rw-b.json" "$SCRATCH/rw-b.json" "$SCRATCH/rw-b.json"
"$PROBE_BUCK2" build //:trust_unique --show-output
"$PROBE_BUCK2" kill
rm -f .buckconfig.local "$SCRATCH/ro-a.json" "$SCRATCH/rw-a.json" "$SCRATCH/rw-b.json" "$SCRATCH/ns-buck2-re-probe/setup.json"
```

Recorded results were A remote execution then B AC hit, RO miss upload denial,
and successful uncached execution after endpoint switching. Endpoint/key
selection was not credential attenuation or a trust boundary. No current
workspace policy, cross-workspace isolation, arbitrary CAS access, or OIDC
writer authorization is proved by those historical observations.

## Result

### Protocol and worker probes

| Probe               | Worker preparation                                       | Result                                       |      Wall |
| ------------------- | -------------------------------------------------------- | -------------------------------------------- | --------: |
| `//:env`, `//:hash` | Default Linux                                            | 2 remote actions; hash matches local bytes   |       6 s |
| Same after `clean`  | Default Linux                                            | 100% AC hits; 0 remote commands              |      <1 s |
| `//:nix_hello`      | Linux Nix startup pool                                   | Absolute `/nix/store` executable runs        | 14 s cold |
| `//:env`            | Default macOS arm64                                      | Darwin 25.3, arm64                           |      17 s |
| `//:nix_hello`      | Darwin Nix startup pool                                  | Absolute Darwin `/nix/store` executable runs | 75 s cold |
| `//:caps_tools`     | Linux capability pool, 212 tool-closure paths / 3.35 GiB | `tsgo`, `bun`, `rustc`, `node` run remotely  | 22 s cold |

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

| Stage                        | Surface                  | Wall, s | Remote | Local | AC hits |
| ---------------------------- | ------------------------ | ------: | -----: | ----: | ------: |
| Local, cache disabled        | Typecheck + emit         |   4.808 |      0 |   193 |       0 |
| Local                        | Unit test                |   0.555 |      0 |     1 |       0 |
| Local                        | Quick after package/test |  41.481 |      0 | 1,083 |       0 |
| Fresh pool, cold action keys | Typecheck + emit         |  58.331 |    193 |     0 |       0 |
| Fresh pool                   | Unit test                |   3.482 |      1 |     0 |       0 |
| Fresh pool                   | Quick after package/test | 136.778 |  1,070 |    13 |       0 |
| After clean                  | Typecheck + emit         |   2.387 |      0 |     0 |     193 |
| After clean                  | Unit test                |   0.769 |      0 |     0 |       1 |
| After clean                  | Quick after package/test |   3.955 |      0 |     0 |   1,083 |
| Source-comment edit          | Typecheck + emit         |   9.338 |      3 |     0 |       0 |
| Source-comment edit          | Unit test                |   3.265 |      1 |     0 |       0 |
| Source-comment edit          | Quick after package/test |  66.452 |     81 |     6 |       0 |

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

| Row                          | Wall, s | Local | Remote | AC hits | Relative to local mean |
| ---------------------------- | ------: | ----: | -----: | ------: | ---------------------: |
| Local cold 1, 8 slots        |  34.668 | 1,276 |      0 |       0 |                      — |
| Local cold 2, 8 slots        |  36.053 | 1,276 |      0 |       0 |                      — |
| RE cold, fresh pool          | 235.276 |    13 |  1,263 |       0 |                  6.65× |
| RE clean-client AC reuse     |   5.105 |     0 |      0 |   1,276 |                  0.14× |
| RE warm workers, AC bypassed | 130.680 |    13 |  1,263 |       0 |                  3.70× |

Local mean was 35.360 s. Cold means cold workers and action keys, not virgin
CAS. Warm execution bypassed AC reads, server cache lookup, and writes, but
retained worker/tool/CAS state; a fifth worker also booted during that row.
Two local samples and one sample per remote posture do not establish a general
provider speed ranking.

| Attribution                      |                            Cold RE |    Warm-worker RE |
| -------------------------------- | ---------------------------------: | ----------------: |
| Median actual command            |                          11.790 ms |         11.221 ms |
| Median client `Re/Execute` stage |                         127.644 ms |        132.355 ms |
| Summed server queue time         |                        1,994.420 s |         301.018 s |
| Summed actual command execution  |                           95.123 s |          87.836 s |
| RE downloads                     |                  700,238,932 bytes | 699,203,001 bytes |
| Materialized output              | 69,786 files / 1,000,603,375 bytes |              Same |

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

| Experiment                                                 | Observed result                                                    | Boundary conclusion                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| RW seeded action; clean; RO endpoint read                  | 1 AC hit / 0 remote, 1.266 s                                       | Reads work                                                            |
| RO endpoint uncached action                                | Upload denied, `PERMISSION_DENIED`, 1.366 s                        | Endpoint denies uploads, not proof of worker execution                |
| Same RO setup bearer; switch to RW storage/scheduler       | Uncached action executes remotely, 2.407 s                         | Bearer is not reader-only                                             |
| Direct RO `UpdateActionResult`                             | Denied                                                             | Endpoint restriction works                                            |
| Same bearer, RW `UpdateActionResult` with identical result | Accepted                                                           | Reader bearer escalates to AC write authority                         |
| Same bearer, scheduler `Execute`, skip cache               | Accepted, 3 operation messages                                     | Reader bearer escalates to execution; separate build proves execution |
| Unique action on key A, clean, key B                       | A: 1 remote, 5.574 s; B: 1 AC hit, 1.265 s                         | `--key` does not isolate AC                                           |
| User/tenant tokens with 15-minute expiry                   | Both grant execution/storage writes; RO setup forwards same bearer | Membership scope is not a reader role                                 |
| Revoke both created tokens, retry setup                    | Both rejected as revoked                                           | Revocation works                                                      |

RO and RW interactive setup returned the same bearer. The test updated an
existing identical ActionResult, not poisoned content. Arbitrary cross-key CAS
access and cross-workspace AC/CAS isolation were not measured. OIDC federation
was documentation research only, not a proved protected-main writer policy.
Untrusted jobs must not receive the tested bearer or a broader replacement
workload identity. Startup-script/direct workers cannot mix trusted and
untrusted work; private artifacts and secret-bearing actions remain outside the
public execution domain.

### Total complexity and economics

| Stage                  |                    Surfaces touched | Persistent integration burden                                                                                                                     | Machinery removed after proof                                                           |
| ---------------------- | ----------------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| S1 public shared cache |                                  14 | Endpoint/root rendering, posture, CI auth, server denial/outage proof, onboarding, workspace/federation/billing, fleet retirement                 | Public bazel-remote process, storage, auth, ingress, activation, public-only monitoring |
| S2 Linux RE            | +10 touched; 18 distinct cumulative | Platform/test routing, action portability, complete closure publication, immutable pool lifecycle/GC, invocation flags, quota and native evidence | No additional deployed machinery; avoids proposed public NativeLink scheduler/workers   |
| S3 macOS RE            |  +5 touched; 19 distinct cumulative | Darwin capability publication, OS-specific startup/routing, trusted-only workers, selected jobs and spend limits                                  | No additional deployed machinery                                                        |

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

### Local critical path and batching prototype

Follow-up on 2026-10-01 to test whether the tiny pnpm store/extract actions
(Track B precondition) also limit local builds.

Attribution used Buck's exact `BuildGraphInfo.critical_path2` from the two
quiet-host local cold runs above (`L-cold-1/2`, revision 3ab9d858, `-j 8`):

| Exact-path component                                      | Run 1 / Run 2, s | Of which slot queue, s |
| --------------------------------------------------------- | ---------------: | ---------------------: |
| TypeScript suffix: 7 `tsgo_emit` + `notion-cli:typecheck` |  23.497 / 24.808 |          0.518 / 1.407 |
| All pnpm store/extract + `package_tree`                   |  10.651 / 10.718 |          8.627 / 9.092 |
| Of which extract+entry                                    |    5.498 / 6.584 |          4.842 / 5.943 |

- 99.61% / 99.70% of summed extract/entry queue time occurs before the first
  TypeScript action starts.
- Pre-execute scheduling overhead is about 0.11 ms per action, so fusing
  extract+entry per package with unchanged command work is estimated at
  0–0.7 s locally (last of five ranked levers; TypeScript suffix and slot or
  materialization contention rank first and second).

A bounded fusion prototype ([batching.patch](./2026-09-30-namespace-remote-execution/batching.patch),
not applied) ran four interleaved clean cold `//:quick` builds on a loaded
32-core host (load average 97–157):

| Run        | Wall, s | Command actions |
| ---------- | ------: | --------------: |
| Baseline 1 | 110.718 |           1,285 |
| Fused 1    | 277.096 |             737 |
| Baseline 2 | 135.443 |           1,285 |
| Fused 2    | 155.955 |             737 |

Host-load variance dominates; no local win is demonstrated. The checked store
entry is byte-identical (25 files, same entry digest) and fused actions stay
cache-eligible (`requires_local=false`). Fusion keys extraction on assembly
dependencies, so independent extract reuse (DEPS-T01) weakens. On current main
the store entries are local-only, so fusion does not reduce the remote-eligible
action count (562) unless entries also become remote-eligible.

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

Historical state at the September experiment / q4 decision: dev3 had an
`nsc login` and the borrowed `buck2-probe` cluster was retained. Owned benchmark
clients/workers were destroyed and created review tokens revoked. This is not
a claim that a login is available now, a deployment requirement or rollout approval.

## Intent Impact

- [Decision 0039](../.decisions/0039-namespace-first-remote-candidate-adoption-deferred.md)
  records deferral and the three re-entry tracks; decisions 0013 and 0037 retain
  their NativeLink history.
- [Decision 0033 Namespace amendment](../.decisions/0033-ci-cache-posture-two-trust-tiers.md)
  records interoperability and failed reader attenuation; the public cache stays
  on self-hosted bazel-remote.
- [Historical Phase 7](../.reference/migration-2026/roadmap.md)
  targets Namespace conditionally and deletes only public cache machinery after
  Track A completes.
- The [platform spec](../04-buck2/02-platforms-toolchains/spec.md#executable-providers)
  records the realized closure/pool mechanism;
  [execution findings](../04-buck2/05-execution/open-questions.md) resolve worker
  realization and correct the 8-slot contention reading with local critical-path
  attribution. No vision or requirement changes.
