# Reuse Spec

This document specifies the client contract for the shared cache and the
verification of reuse claims. It builds on [requirements.md](./requirements.md).

## Status

Draft.

## Scope

**Defines:** client wiring, executor configuration, and reuse verification.

**Does not define:** service deployment (dotfiles#2009), consumer admission
sequencing (effect-utils#1054), or remote execution (deferred; see roadmap).

## Client Contract

Protocol initialization follows [the cache contract](../../02-cache-contract/spec.md#re-client-initialization).
All client configuration, including the overlay below, must exist in
`.buckconfig.local` **before daemon startup**. `--config-file` and `--config`
do not configure the RE client. Change posture by stopping the daemon and
starting with the new file and environment ([#1598](https://github.com/overengineeringstudio/effect-utils/pull/1598)).

```ini
# tracked buckconfig: the repository's trust tier, read-only (decision 0033);
# -c CLI overrides do not reach the RE client
[buck2]
digest_algorithms = SHA256
allow_cache_uploads = false
[buck2_re_client]
engine_address = grpc://<tier-host>:<port>
action_cache_address = grpc://<tier-host>:<port>
cas_address = grpc://<tier-host>:<port>
instance_name = <repo-name>
tls = <true for the public tier>
```

`mkConsumerBuckRoot` renders all three client addresses whenever remote client
configuration is supplied, including when `remoteCacheEnabled = false`. Its
optional `engineAddress` parameter defaults to `null`; a null value resolves to
`actionCacheAddress`, matching this contract's shared tier endpoint. Consumers
with a distinct engine endpoint set `engineAddress` explicitly. The action
cache address, CAS address, instance name, and TLS flag must be supplied
together; the resolved engine address must be a string. Buck requires the engine
address to initialize its RE client even for cache-only local execution.

Public effect-utils reads the public tier anonymously. Protected public publishers
holding `BUCK2_CACHE_WRITE_BASIC_AUTH` receive the publisher overlay.
Tailnet hosts resolve their own raw `username:password` credential into
`BUCK2_PRIVATE_CACHE_WRITE_AUTH`; the shipped pinned `buck2` entrypoint converts it to
`BUCK2_PRIVATE_CACHE_WRITE_BASIC_AUTH` before starting the native executable. The private writer
also declares `BUCK2_PRIVATE_CACHE_ADDRESS=grpc://<private-host>:<port>`.
Its overlay sets all three RE client addresses, disables TLS for the direct
private listener, permits root-authorized uploads, retains the trusted private
archive origin, and references the Basic header variable. Credential values
never enter the config file; the daemon expands the variable at startup.
The public read-only override takes precedence over either credential.
No publisher credential is a fallback for a host writer.

Public CI declares every job's Buck cache posture in the Genie workflow source:

| Posture  | `BUCK2_NO_REMOTE_CACHE` | `BUCK2_PUBLIC_CACHE_READ_ONLY` | Authority                                                |
| -------- | ----------------------- | ------------------------------ | -------------------------------------------------------- |
| `writer` | `0`                     | `0`                            | Protected-main proof step supplies the writer credential |
| `reader` | `0`                     | `1`                            | Anonymous reads; credentials cannot enable uploads       |
| `none`   | `1`                     | `1`                            | Inert PR proof; no remote-cache reads or uploads         |

Generation rejects missing or unknown job declarations and conflicting explicit
job environment settings. The trusted proof is main-only (push or manual dispatch)
on its declared runner; all other CI jobs remain readers except the inert PR proof.
The writer secret stays step-local. The proof's fresh replay root explicitly selects
reader posture before daemon startup, so it cannot reuse writer authority.
Reader declarations may disable remote caching under an explicit condition:
measurement baseline backfills do so for older revisions without public-reader
posture support. This conditional opt-out cannot enable uploads.

Default executor platforms deny remote-cache reads and writes regardless of
root upload policy. Audited actions request the paired `cache_hermetic` execution
platform, which reads `remote_cache_enabled` and `allow_cache_uploads` from root
config (local execution, remote reuse; `remote_enabled = False`).
`BUCK2_NO_REMOTE_CACHE=1` wins over all credentials and disables reads/uploads.
Read-only endpoint admission failures fail open; either selected writer posture
fails closed on REAPI unavailability.

### Local Materialization Policy (BUILD.BUCK.REUSE-R08–R10)

```text
cheap file-heavy materialization -> default local executor -> no AC reads/writes
audited compute/verdict action  -> cache_hermetic executor -> root cache posture
```

**BUILD.BUCK.REUSE-DQ04 (resolved):** `pnpm_extract`, `pnpm_store_entry`,
`pnpm_store_scc`, `pnpm_store_view`, and `package_tree` execute locally without
remote-cache lookup or upload. Their rules retain `cache_guarded_rule` but do
not admit the `cache_hermetic` constraint; their actions prohibit cache uploads.
The default execution platform has `remote_cache_enabled = False` and
`allow_cache_uploads = False`, independently of the root writer posture.
`local_only` alone is insufficient: it restricts execution, not remote-cache
reads. Compute actions such as `tsgo_emit` retain audited remote-cache admission.

The policy favors recomputing cheap filesystem projections over transferring
their expanded trees. The Linux test-lane bootstrap in
[run 37583314483](https://github.com/overengineeringstudio/effect-utils/actions/runs/37583314483)
completed its Buck invocation in 7.062 s with 660 local command actions. In
[run 37596446639](https://github.com/overengineeringstudio/effect-utils/actions/runs/37596446639),
the corresponding invocation took 1071.022 s with all 660 commands hitting the
remote cache: the action span occupied 441.166 s, followed by 629.856 s before
command completion. Successful admission exposed expensive cache-hit reads,
not a cache-key or admission failure.

The latter invocation's cached `ActionResult`/`Tree` metadata gives this output
cardinality; bytes count regular-file payload per output, before deduplicating
content shared across actions:

| Category           | Actions | Output files | Output bytes | Baseline median action wall time |
| ------------------ | ------- | ------------ | ------------ | -------------------------------- |
| `pnpm_extract`     | 322     | 29,423       | 646,157,901  | 0.796 s                          |
| `pnpm_store_entry` | 309     | 28,751       | 616,824,427  | 0.530 s                          |
| `pnpm_store_scc`   | 4       | 672          | 29,333,474   | 0.070 s                          |
| `pnpm_store_view`  | 9       | 0            | 0            | 0.022 s                          |
| `package_tree`     | 9       | 2,910        | 12,488,324   | 0.020 s                          |

The views also contain 179 symlinks. Including the seven `tsgo_emit` outputs,
the required final closure has 27,945 unique regular-file blobs totaling
638,909,738 bytes (609.312 MiB). Every extract-output blob also occurs in that
required closure. Read-only ByteStream measurements from a separate clean
vantage yielded 1.082 MiB/s over public ingress versus 15.066 MiB/s over the
direct private path for four concurrent 10,032,264-byte reads; persistent
1 KiB reads had median latencies of 30.374 ms and 3.466 ms respectively.
These are diagnostic transport samples, not a measured post-policy lane time.
Even the faster path transfers roughly 40 s of payload to avoid a 7 s local
build. Disabling uploads also avoids publishing expanded filesystem trees over
the shared cache transport.

Deferred materialization is already Buck's default. The external editor
publisher requires the manifest's declared backing roots locally, and
`DefaultInfo.other_outputs` makes them final outputs. Skipping final
materialization without changing publication would leave missing files;
deferring intermediates does not remove unique payload from this closure.
The policy therefore changes rule admission, not final-output completeness.

Evidence names these categories' exclusion `local-materialization-policy`.
Native outcomes remain intact, but policy-excluded actions are reported
separately and never enter R08 avoidable-execution candidates or warm99's
eligible-hit/miss denominator, even when historical rows show remote hits.

### Direct Invocation Admission (BUILD.BUCK.REUSE-R04)

```text
pinned buck2 -> healthy Watchman + correct watched root -> invocation admission
            -> unavailable/misrooted Watchman -> actionable failure, no native build
invocation admission -> identical healthy invocation cache -> native Buck
                     -> concurrent bounded probes -> native Buck + endpoint outage overrides
```

The flake's pinned executable owns admission for direct agent commands, devenv
tasks and consumer roots. It resolves the nearest `.buckroot`, reads the tracked
and local Buck configuration, applies the shared environment posture, and probes
REAPI `GetCapabilities` and the trusted archive origin concurrently. Each endpoint
gets 2500 ms per attempt including connection setup, with exactly one immediate
retry after a failed first attempt and at most 5000 ms total probing per endpoint.
Watchman admission is separate from these remote-endpoint outage policies.
An uncached Watchman-configured invocation, including an explicit local Watchman
override, runs `watchman --no-local [--sockname=...] --output-encoding=json
watch-project <canonical Buck root>`. This single request verifies service
availability and requires the returned canonical watched root to equal the
resolved `.buckroot`; an ancestor-relative watch is rejected, even if its
coverage appears sufficient. A service/version query alone is insufficient,
and an ancestor watch whose ignore rules exclude the project is unsafe.
Each attempt uses the caller's probe deadline (2500 ms by default), replacing
the former 900 ms cap. Only a timeout gets one retry; total probing is bounded
to two caller deadlines (5000 ms by default).

Missing executable, unavailable service, exhausted timeout, malformed/error
response or incorrect watched root fails closed with the root, attempted command,
failure reason and actionable remediation; none selects notify automatically.
Root mismatch directs the caller to `watchman watch <root>`; other failures
explain service/socket/version diagnostics. Only successful admission is cached
for five seconds, keyed by canonical root, `.watchmanconfig` contents and
process/socket identity. Healthy invocation-cache shortcuts reuse only completed
successful admission and include `.watchmanconfig` contents and the selected
isolation's provider marker in their identity; old fallback launch-cache entries
are outside the current cache namespace. Missing markers bypass the shell
shortcut.
Existing healthy local overrides remain intact;
stale managed notify fallback configuration is never used for admission.

After successful admission, Watchman-configured worktrees reconcile only the
invocation's isolation (`--isolation-dir`, then `BUCK_ISOLATION_DIR`, then `v2`).
A missing provider marker is legacy state; a mismatched marker is a provider
transition. Under a crash-released per-root/isolation flock, either state stops
only the registered daemon at `~/.buck/buckd/<root>/<isolation>/buckd.pid`,
through native `--isolation-dir <isolation> kill` with the same worktree as its
working directory. A failed stop prevents startup and marker publication.
Success atomically records the selected provider at
`~/.buck/file-watcher-admission-v1/<root>/<isolation>.json`, outside the daemon
directory that native startup cleans. Matching markers prevent repeated stops;
other roots and isolations are untouched. Maintenance `kill`, `status`, and
`log` commands bypass both admission and migration so outages remain diagnosable.

The existing explicit `.buckconfig.local` overrides for `notify` and
`fs_hash_crawler` remain local opt-ins, not outage policies. In particular,
`[buck2] file_watcher = notify` is preserved without automatic selection.
It is unsafe for agent builds: a completed source write can precede a successful
build while its notification is still absent from the batch used to evaluate
the source digest. The pinned
[notify implementation](https://github.com/facebook/buck2/blob/be6971d47dcc835b7356e1698b23039ffee4f4c2/app/buck2_file_watcher/src/notify.rs)
swaps the callback buffer without a filesystem-event delivery barrier. This
mechanism was reproduced with same-daemon recovery and does not require a
long-lived daemon; attribution of the original historical persistent stale
copy to this exact race is not proven. Agent workflows must provide a healthy,
correctly rooted Watchman service instead of using this explicit unsafe opt-in.

Remote endpoint outcomes expire after five seconds. Complete successful
read-only invocations can bypass the JavaScript launcher within the remaining
probe lifetime; the key includes config contents, arguments, working directory
and exported environment. Writer credentials, includes and external mode files
bypass that fast path.

RE client configuration alone opts into admission. A missing
`remote_cache_enabled` inherits the execution policy's enabled default;
RE-only roots do not need trusted archive metadata.

Only failure of both attempts selects an endpoint's outage policy. Read-only
REAPI admission failures disable cache reads/uploads while retaining local
execution; required writers fail closed after both REAPI attempts fail.
Archive-origin admission failures clear the origin prefix and select the
registry; a reachable REAPI client remains enabled. Every fail-open invocation
emits the existing warning. Outage overrides are CLI root-config values, not
persistent endpoint changes; RE client identity/credentials still require a
managed root overlay before daemon startup.

Admission is a reachability snapshot, not a native runtime circuit breaker.
An endpoint that fails after a successful probe can still fail a native action;
the pinned native client has ten hard-coded connection attempts with 45 seconds
of cumulative backoff and no configurable startup fallback.

## Reuse Verification

Reuse claims are verified from Buck-native evidence (cache-hit classes in the
build report and event log), not from wall-clock inference:

1. Populate: build an admitted target in context A.
2. Wipe: `buck2 kill` and remove `buck-out` in context B (second worktree or
   second machine, same platform, same revision).
3. Rebuild in B: assert zero locally executed actions for unchanged,
   remote-cache-admitted targets (BUILD.BUCK.REUSE-R02); investigate any eligible
   miss as a key regression using action-digest comparison from the event log.

Budget measurements (BUILD.BUCK.REUSE-R03)
run on a quiet host or record load context; contention-dominated numbers are
not regressions.

### CI cache-evidence artifacts

```text
native log show -> allowlisted incremental projector
                  +-> buck2-cache-evidence.json (compact, <=64 representatives)
                  +-> buck2-cache-actions.jsonl.gz (every first action end)
writers + expected fresh readers -> warm99 per-lane evaluator
```

CI retains `buck2-cache-evidence-<job>[-<matrix-index>]-<run-attempt>` artifacts
for 14 days. Each upload contains both files. The compact summary remains schema
version `1`: complete native outcome `counts`, per-build-ID `invocations`, and at
most 64 representative `actions`. Its existing `droppedActionCount` continues
to describe omitted **representatives**, not missing full-artifact rows.
Populate and replay invocations retain proof context labels; repeated native
logs are deduplicated by build ID, preserving the first context.
Summary and per-invocation `excludedByDesign` contain
`{ "local-materialization-policy": <count> }`. Native `counts` still retain
every observed outcome; the exclusion counters are a separate policy axis,
not an alternative execution-kind mapping.
Retained schema-1 full artifacts without policy fields derive exclusions from
their complete category rows. Older bounded summaries may omit
`excludedByDesign`: their sampled rows cannot reconstruct a complete total,
so absence means unavailable, not zero. New collectors always emit the counters.

Admission evidence is independent of native execution evidence. Before writer
fail-closed handling, every direct invocation that probes cache appends a UTF-8
JSONL row to `${CI_BUCK2_CACHE_EVIDENCE_PATH}.admission.jsonl`, with the authoritative
`CacheAdmissionInvocation` shape:

```json
{
  "invocationId": "9552ef6c-294e-4a51-9100-9006d6f2c343",
  "admissionFallbacks": { "reapi": 0, "archiveOrigin": 0 },
  "admissionRetrySuccesses": { "reapi": 0, "archiveOrigin": 1 }
}
```

`invocationId` uses `BUCK_WRAPPER_UUID`: the entrypoint preserves an existing
caller/OTel UUID or generates a random UUID when absent, and passes it to native
Buck as its trace ID. It therefore joins directly to native `buildId` when Buck
runs; denied writers still retain admission evidence without a native event.
Both persistence and decoding canonicalize Buck's accepted UUID spellings
(32-hex, hyphenated, braced, or UUID URN) to its lowercase hyphenated native
trace ID, without imposing version or variant bits.
Evidence-enabled invocations bypass the native-launch argument fast path so it
cannot reuse a prior UUID or skip admission counters. The compact summary adds
`admissionInvocations` (these rows, deduplicated by invocation UUID),
`admissionFallbacks` and `admissionRetrySuccesses` (endpoint-wise sums across
those rows). Each endpoint counter is 0 or 1 per invocation: healthy first
attempts have zeroes, failure of both attempts records one fallback, and a
successful second attempt records one retry success without a fallback. A reused
cached failure still records one fallback for that invocation; reused cached
health records no retry success. An endpoint not probed has zeroes. These are
admission decisions, not action-cache misses or native upload failures, and do
not enter the warm99 action denominator.
The sidecar survives devenv task boundaries and is consumed into the compact
summary, not uploaded as a separate raw artifact. Collector finalization writes
fallback counts and invocation IDs to `GITHUB_STEP_SUMMARY`; the existing stderr
warning remains available at invocation time.

The summary adds `cacheOutcomeMapping: "effect-utils/compact-cache-outcome/v1"`
and `actionsArtifact: { name, rows, sha256, bytes, uncompressedBytes, complete,
droppedActionCount }`. `name` is `buck2-cache-actions.jsonl.gz`; `sha256` hashes
the compressed bytes. Valid complete evidence satisfies
`actionsArtifact.rows == actionCount`, and both full-artifact dropped counts are
zero. Existing compact consumers need not change.

The gzip payload is UTF-8 JSONL with a header followed by one action record per
first native `ActionExecution` end span. Rows are never grouped or sampled.
Missing fields remain explicit `null`; they do not suppress a row.

| Header field            | Contract                                                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`, `schemaVersion` | `"header"`, `1`                                                                                                                                |
| `cacheOutcomeMapping`   | Repository-owned versioned mapping identifier above                                                                                            |
| `metadata`              | `repo`, `runId`, `runAttempt`, `job`, `lane`, `headSha`, `posture`, `startedAt`, `finishedAt`; once per file                                   |
| `lane`                  | `main-writer`, `main-reader`, `merge_group`, or `pr`; unknown is `null` and cannot pass                                                        |
| `posture`               | `read-only`, `writer`, or `disabled-by-design`                                                                                                 |
| `status`                | `collected`, `no-native-logs`, or `remote-cache-disabled-by-design`                                                                            |
| Completeness            | `complete`, `actionCount`, `rows`, `droppedActionCount`, `missingDigestCount`, `missingIdentityCount`, `missingTimestampCount`, `evidenceGaps` |
| `invocations`           | Native `buildId`, `context`, command `startedAt`/`completedAt`, `freshRoot`, `actionCount`, `excludedByDesign`, and `complete`                 |
| `excludedByDesign`      | Reason-keyed counts, including `local-materialization-policy`; independent of native outcome counts                                            |

| Action field          | Contract                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`                | `"action"`                                                                                                                                  |
| Identity              | `buildId`, `context`, `category`, `target`, full `configuration`, exact native AC `digest` (`hash:size`)                                    |
| Native classification | Integer `executionKind` and `cacheUploadResult`, retained even when the normalized outcome overrides the kind                               |
| Outcomes              | `outcome` and `cacheOutcome` use the named compact mapping; `uploadOutcome` is `uploaded`, `failed` (native values 9–15), or `not-uploaded` |
| Times                 | `startedAt`, `completedAt`, `endTime` (same as completedAt), `uploadCompletedAt`                                                            |
| `commandAction`       | Native action kind is `Run`; non-command actions are retained but do not form a command-cache denominator                                   |
| `exclusionReason`     | Repository-owned exact reason `local-materialization-policy` for the five policy categories; `null` otherwise                               |

All times are integer Unix milliseconds. The pinned log decoder emits native
timestamps as `[seconds,nanoseconds]`; conversion floors sub-millisecond time.
`uploadCompletedAt` is the successful action-end timestamp: a conservative
upper bound on completed upload, never an inferred start plus `wall_time`.
Equality with reader start is **not** prior completion. Missing command starts,
command ends, identity/digest/timestamps, unpaired action starts, unsupported
native enums, decode/discovery errors, checksum mismatches, and truncated data
invalidate an observation. Legitimate nondigest non-command actions still
contribute to omission counters, not a fabricated AC identity.

The projector emits only allowlisted labels, configuration names, native digest
strings, enum numbers, times, and run identity. Host paths, environment values,
commands, outputs, host names, and raw error payloads are never copied. Invalid
identity text becomes `null` rather than a lossy replacement key. The
repository-local mapping identifier has exact case-sensitive spelling and a
version suffix; unknown versions are rejected, not silently reinterpreted.
In particular, compact `uploaded` takes precedence over execution kind, and
kind `7` maps to `local-cache`; consumers retain raw enums so that they need not
call local-dep-file reuse a remote hit.

Compression uses deterministic gzip with level 9. A 64 MiB uncompressed
action-payload ceiling bounds retained bytes; overflow retains the available
prefix and records a size-limit gap and dropped count. Such an artifact is
**invalid**, never an accepted complete observation. The summary measures both
compressed and uncompressed bytes. Collection continues after failed native
logs, recording gaps before finalizing; the upload step always retains available
evidence independently of OTLP delivery.

Freshness is a positive proof, not an assumption from checkout. The CI start
window records that the canonical tracked root has no `buck-out` file or
symlink. Finalization uses native command timestamps to grant freshness only
to the unique earliest invocation from that root; later invocations are
excluded. Tied/unknown starts, redirected roots without proof, and preexisting
native state cannot claim freshness. The two-root proof explicitly marks only
the first build after each wiped root, preserving its populate/replay labels.
Every retained invocation must satisfy the native-time enclosure
`job.startedAt <= invocation.startedAt <= invocation.completedAt <= job.finishedAt`.
Equality is valid at millisecond precision. Missing or out-of-window bounds retain
rows only as incomplete evidence and revoke freshness; filesystem mtime cannot
make an older native invocation part of the current observation.

In-Nix product jobs retain disabled-by-design headers and zero action rows.
Their reuse metric is Nix substitution, not Buck AC. The daily cache-health
mission and post-merge proof consume the full contract.
See [observability](../07-observability/spec.md#ci-action-cache-evidence) for
the legacy compact outcome classes and missing-evidence counters.

### Per-lane warm99 evaluation

```text
writer upload completion < fresh reader command start
    exact (category,target,configuration,digest) join
    eligible remote identities / eligible identities
    >=99% for each enabled lane, twice consecutively
```

`bun genie/ci-scripts/buck2-cache-warm99.ts --manifest <manifest.json>` accepts
an explicit expected-observation manifest, not a directory glob that can silently
omit a failed job:

```json
{
  "schemaVersion": 1,
  "enabledLanes": ["main-reader", "merge_group", "pr"],
  "observations": [
    {
      "id": "observation-1",
      "sequence": 1,
      "writers": [
        {
          "lane": "main-writer",
          "summary": "writer/buck2-cache-evidence.json",
          "actions": "writer/buck2-cache-actions.jsonl.gz"
        }
      ],
      "readers": [
        {
          "lane": "main-reader",
          "summary": "reader/buck2-cache-evidence.json",
          "actions": "reader/buck2-cache-actions.jsonl.gz"
        }
      ],
      "nixSubstitution": { "substituted": 0, "built": 0 }
    }
  ]
}
```

Paths resolve relative to the manifest; reports omit them. Observation sequence
numbers strictly increase. Each enabled lane has explicitly enumerated reader
jobs, and each expected job needs a complete fresh invocation. All writer
artifacts must be complete before they establish eligible uploads. The reader
tuple is eligible only where an exact successful upload completed strictly
before that fresh reader invocation started. Duplicate identities count once;
all eligible fresh occurrences of an identity must have raw execution kind `3`
to count as a remote hit. Local-cache and local-dep-file outcomes are misses,
not remote hits, even if the compact mapping groups them as local-cache.
Writer and reader repository metadata must agree. Distinct observations require
distinct native reader build IDs; replaying one artifact under a new manifest
sequence is an evidence gap, not a second fresh-root measurement.

Freshness belongs to the first cache-bearing native invocation in a fresh job
root: no earlier invocation may have executed or cached any action. Zero-action
audits do not consume freshness. Every invocation after the first cache-bearing
one is nonfresh, even when its command is otherwise cache-enabled.

Buck's native `LocalActionCache` (execution kind `10`) reuses an earlier local
action without command metadata, so its RE action digest can be absent. Retain
these rows with `digest: null`; only a known nonfresh invocation may classify
them as excluded-nonfresh rather than an evidence gap. Fresh command rows still
require native digests, and uploaded rows always require their native digest.
The codec's `classifyCacheAction` identifies kind `10` as a local-action-cache
hit, never an avoidable local-execution candidate. Such candidates are only
non-policy-excluded command actions of kind `1` or `8` with a native digest in
a matched fresh invocation (`fresh-local-execution`); every other outcome is
outside that set. Policy exclusion does not relabel a kind `10` cache hit.
Missing identity fields or timestamps remain evidence gaps. Cargo and
default-ref-policy jobs execute no native Buck actions and are explicitly
disabled-by-design, not remote-cache reader or writer lanes.

The report separates cold tuples (no prior upload), changed tuples (same
category/target/configuration, different prior uploaded digest), excluded
nonfresh/disabled actions, reason-keyed `excludedByDesign` policy counts,
noncacheable native actions, upload failures, and evidence gaps. Policy rows
cannot seed the prior-upload cohort or enter the eligible denominator, including
historical remote-hit/upload rows. Nix substitution totals are separate and
never augment the Buck denominator.
Missing expected jobs/files, malformed/schema-incompatible or
truncated artifacts, checksum/row-count mismatch, and unavailable identity/time
evidence invalidate the observation. Zero eligible identities do not pass.

Each enabled lane must reach a warm eligible remote-hit rate of at least 99%
in two consecutive complete observations. An evidence gap breaks the streak;
rates are not pooled across lanes or observations. The CLI emits a normalized
JSON report and exits nonzero when acceptance is unmet or input is invalid.
This temporal eligible-denominator measurement is distinct from the legacy
observed action-span rate and from Nix substitution.

### Action reuse versus verdict reuse

| Claim                   | Required native evidence                                                                           | Insufficient evidence                            |
| ----------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Compile/action reuse    | Action-cache hits, zero unchanged command executions and matching configured keys                  | Fast wall-clock alone                            |
| Unit-test verdict reuse | Cache hits for verdict-producing build actions and equal pass/fail reports without suite execution | Compile hits or local test orchestration success |

Populate and replay deterministic passing suites from
[execution's verdict actions](../05-execution/spec.md#cacheable-unit-test-verdict-actions).
A failed suite exits nonzero and is not uploaded, so a red result reruns rather
than replaying. Relevant source/runner/policy mutations invalidate a passing
result, and irrelevant mutations do not. Flaky tests and host-dependent lanes
are uncached; they are not deterministic admitted targets.
The native proof identifies the `unit_test_verdict` action by category, requires
an upload from context A and a remote action-cache hit in context B, and compares
the normalized report and result content hashes. Local execution of the small
`buck2 test` adapter is not suite execution: the adapter only reads the verdict.
The red control requires two nonzero local verdict actions with no upload; the
irrelevant-mutation control requires no locally executed verdict action.

### JavaScript product descriptor reuse

**BUILD.BUCK.REUSE-DQ03 (resolved):** `javascript_product_descriptor` projects a
declared module descriptor using pinned Bun and the declared package-command
runtime. The rule owns `cache_guarded_rule` eligibility and its macro selects the
shared hermetic constraint. `hermetic_action` scrubs ambient environment and
`hermetic_bun_command` disables `.env`, install discovery and ambient Bun config.
`local_only` limits execution to the local executor; it does not prohibit remote
action-cache reads on the admitted lane.

`configuredTarget` records canonical cell/target names and the target
configuration hash, not the checkout's filesystem root. It remains provenance
in `effect-utils/javascript-product/v2`; no descriptor fields are removed or
moved. The JavaScript Nix importer checks exact descriptor fields and bytes but
does not compare provenance. This projection is distinct from the strict native
`buck-build-product/v1` contract and does not change that schema or its importer.

The two-root regression requires a locally executed/uploaded descriptor in
context A, a remote descriptor action-cache hit in context B, byte-identical
descriptor files, and zero executed/local-cache build actions on B.

### Lane budget measurements

Record edit-run, quick check, full tests and platform/host proof separately. For
each lane record platform, revision, target closure, cache posture, warm no-op,
fresh-context warm-cache time and host load. No 5-second/3-minute universal budget
is substituted for a measured lane budget (axe record `uttvbj`).

### Cache efficiency measurement

BUILD.BUCK.REUSE-R08–R14 retain their rolling 7-day evidence window. The legacy
compact observed rate counts native outcome spans:
remote hit / (remote hit + local execution + local cache + upload).
The warm99 acceptance gate uses the distinct exact-identity, prior-upload,
fresh-root denominator specified above, not that observed aggregate.

| Requirement | Evidence                                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| R08–R10     | Full CI action-identity artifacts and warm99 reports; R08 joins local executions against prior successful public-tier uploads |
| R11         | public tier server request counters (`GetActionResult` hits/misses, `UpdateActionResult` writes)                              |
| R12         | weekly two-root probe per trusted host, native event log                                                                      |
| R13         | narinfo presence for each published product and the publish-run derivation diff                                               |
| R14         | daily cache-health measurement history                                                                                        |

R09 and R10 apply only to lanes where queue writers populate the public tier
before readers run. Rates measured before that ordering exists form a separate
pre-ordering baseline
([2026-10-06 baseline](./.experiments/2026-10-06-cache-efficiency-baseline.md)).

## Open Design Questions

- **BUILD.BUCK.REUSE-DQ01 Lane budget values:** Blocked on the first honest
  measurement pass across all four lanes. Resolve with published measurements
  and accepted per-lane limits; values are intentionally unset.
- **BUILD.BUCK.REUSE-DQ02 Writer attribution and purge integration:** Blocked on
  consumer/service designs for revocable per-host credentials, authenticated
  action-key logging and targeted AC purge. A worker-name field or IP log is
  insufficient attribution; instance names alone do not isolate keys.
