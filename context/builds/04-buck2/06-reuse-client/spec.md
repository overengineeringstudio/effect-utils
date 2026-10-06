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

### Direct Invocation Admission (BUILD.BUCK.REUSE-R04)

```text
pinned buck2 -> identical healthy invocation cache -> native Buck
            -> concurrent bounded probes -> native Buck + outage overrides
```

The flake's pinned executable owns admission for direct agent commands, devenv
tasks and consumer roots. It resolves the nearest `.buckroot`, reads the tracked
and local Buck configuration, applies the shared environment posture, and probes
REAPI `GetCapabilities` and the trusted archive origin concurrently with 900 ms
deadlines. Endpoint outcomes expire after five seconds. Complete successful
read-only invocations can bypass the JavaScript launcher within the remaining
probe lifetime; the key includes config contents, arguments, working directory
and exported environment. Writer credentials, includes and external mode files
bypass that fast path.

RE client configuration alone opts into admission. A missing
`remote_cache_enabled` inherits the execution policy's enabled default;
RE-only roots do not need trusted archive metadata.

Read-only REAPI admission failures disable cache reads/uploads while retaining
local execution. Archive-origin admission failures clear the origin prefix and
select the registry; a reachable REAPI client remains enabled. Every fail-open
invocation emits a warning. Outage overrides are CLI root-config values, not
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
3. Rebuild in B: assert zero locally executed actions for unchanged targets
   (BUILD.BUCK.REUSE-R02); investigate any miss as a key regression using action-digest
   comparison from the event log.

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
| `invocations`           | Native `buildId`, `context`, command `startedAt`/`completedAt`, `freshRoot`, `actionCount`, and `complete`                                     |

| Action field          | Contract                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`                | `"action"`                                                                                                                                  |
| Identity              | `buildId`, `context`, `category`, `target`, full `configuration`, exact native AC `digest` (`hash:size`)                                    |
| Native classification | Integer `executionKind` and `cacheUploadResult`, retained even when the normalized outcome overrides the kind                               |
| Outcomes              | `outcome` and `cacheOutcome` use the named compact mapping; `uploadOutcome` is `uploaded`, `failed` (native values 9–15), or `not-uploaded` |
| Times                 | `startedAt`, `completedAt`, `endTime` (same as completedAt), `uploadCompletedAt`                                                            |
| `commandAction`       | Native action kind is `Run`; non-command actions are retained but do not form a command-cache denominator                                   |

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

The report separates cold tuples (no prior upload), changed tuples (same
category/target/configuration, different prior uploaded digest), excluded
nonfresh/disabled actions, noncacheable native actions, upload failures, and
evidence gaps. Nix substitution totals are separate and never augment the Buck
denominator. Missing expected jobs/files, malformed/schema-incompatible or
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
