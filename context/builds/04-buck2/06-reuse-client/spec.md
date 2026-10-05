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

CI retains `buck2-cache-evidence-<job>[-<matrix-index>]-<run-attempt>` artifacts
for 14 days. Each contains `buck2-cache-evidence.json`, schema version `1`:
allowlisted run/job/revision/posture metadata, complete native outcome `counts`,
per-build-ID `invocations`, and at most 64 representative `actions` with
category, target, configuration, exact action digest, and outcome. Populate and
replay invocations retain their proof context labels; repeated native logs are
deduplicated by build ID.

Consumers must distinguish `collected`, `no-native-logs`, and
`remote-cache-disabled-by-design` statuses. In-Nix product jobs use the last
status and zero action rows; their reuse metric is Nix substitution, not Buck AC.
The daily cache-health mission and post-merge proof consume this contract.
See [observability](../07-observability/spec.md#ci-action-cache-evidence) for
outcome classes and missing-evidence counters.

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

### Lane budget measurements

Record edit-run, quick check, full tests and platform/host proof separately. For
each lane record platform, revision, target closure, cache posture, warm no-op,
fresh-context warm-cache time and host load. No 5-second/3-minute universal budget
is substituted for a measured lane budget (axe record `uttvbj`).

## Open Design Questions

- **BUILD.BUCK.REUSE-DQ01 Lane budget values:** Blocked on the first honest
  measurement pass across all four lanes. Resolve with published measurements
  and accepted per-lane limits; values are intentionally unset.
- **BUILD.BUCK.REUSE-DQ02 Writer attribution and purge integration:** Blocked on
  consumer/service designs for revocable per-host credentials, authenticated
  action-key logging and targeted AC purge. A worker-name field or IP log is
  insufficient attribution; instance names alone do not isolate keys.
- **BUILD.BUCK.REUSE-DQ03 Product descriptor reuse:** The strict build half of
  the trusted remote-cache proof still executes one local
  `javascript_product_descriptor` action on the second root, while every other
  build and test action is a remote hit. Open: admit the descriptor action to a
  hermetic lane, or accept it as local-only work and exempt it from the proof.
