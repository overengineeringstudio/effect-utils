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

In CI, the entrypoint admits each command against the running daemon's RE
posture while holding one project-root lock from overlay selection
through daemon initialization and recording:

```text
no daemon -> start with current environment -> record identity + keyed posture
matching identity + posture -> reuse (including a busy matching daemon)
idle mismatch or unknown prior posture -> restart -> record
busy mismatch or unrecognized status -> fail closed, leave daemon untouched
```

The record is `buck-out/.cache-daemon-posture/root.json` (mode `0600`).
It contains a random per-record HMAC key, daemon identities and SHA-256 HMACs
of expanded RE configuration and writer policy keyed by isolation, and live
launcher PID/birth/fingerprint/isolation reservations, never the credential itself.
Credential rotation changes the fingerprint; neither key nor fingerprint is printed.
A crash-released root-wide flock is acquired before overlay reconciliation.
Before changing the overlay, a mismatched live launcher or busy daemon in the
same isolation fails closed. Legacy live reservations without isolation retain
root-wide protection until exit. The launcher reservation is written before releasing that lock:
The launcher stays alive while supervising cache-enabled readers; other commands
use `execve`, preserving its PID and process birth identity until the native command
exits. Both cover the gap before Buck reports an active command without inheriting
a lock into buckd. Birth is Linux `/proc/<pid>/stat` field 22 or macOS `ps lstart`;
reused PIDs do not preserve dead reservations. Unknown identity fails closed.
Matching concurrent launches and differently postured daemon isolations can proceed together.
Native status uses the existing gate root/isolation/active-command checks.
Buck has no conditional kill RPC: an unwrapped client can race an idle status
read, but a daemon already observed busy is never killed. CI bypasses the warm
shell launch cache so every command checks daemon identity and posture.

Because Buck rereads root-wide configuration per command, admission also writes
a private `0600` per-isolation policy file and passes it with `--config-file` to
the native invocation. It pins RE client settings, upload permission, default
action-upload permission and remote-cache enablement, including explicit reader
defaults for absent writer-only settings. Its filename is isolation-derived,
not fingerprint-derived, and credential variables remain unexpanded on disk.
The invocation expands readable text `@argfile` and `--flagfile PATH` inputs,
including nesting, with pinned Buck's line/cwd/separator semantics. It inserts
the policy before the first expanded `--` (and before a `run` target), then
executes that expanded argv. Native `--reuse-current-config` is removed only
before the payload boundary; executable, test and BXL payloads remain intact.
Unreadable, cyclic, stdin, Python, cell-resolved or unsupported argfile forms
fail closed rather than risk an unpinned invocation.
The shared overlay remains serialized through native daemon startup.
The snapshot and fingerprint use the effective admitted policy after REAPI
fallback, not only the root overlay: a failed reader or optional-writer probe
pins remote caching and uploads off. Absent root `remote_cache_enabled` and
`allow_cache_uploads` retain the rule policy's `true` defaults; the tracked
reader's explicit upload prohibition still wins. Absent action-upload default
remains native `false`, and absent HTTP headers remain empty.
REAPI admission precedes reservation comparison and overlay mutation while holding
the startup lock. In CI with a GitHub job-instance identity, the first fresh
probe result is pinned per canonical project root and `(GITHUB_RUN_ID,
GITHUB_RUN_ATTEMPT, GITHUB_JOB, BUCK2_CI_JOB_INSTANCE)`. Composed workflows
initialize `BUCK2_CI_JOB_INSTANCE` once during inline job bootstrap, immediately
after the Linux sandbox policy and before checkout or Buck, using a random nonce
persisted through `GITHUB_ENV`, so even sequential matrix children on the same
runner/root receive distinct identities. Later launches in that instance with
the same endpoint/auth identity retain its availability decision even if the
endpoint recovers. Each distinct job instance gets a fresh probe. Unconfigured
CI jobs without the instance identity retain the bounded five-second probe
cache, recorded as `unpinned-missing-job-instance` in admission evidence; they
neither share matrix-parent pins nor acquire a new admission refusal. Local
invocations retain their existing probe cache. Explicit cache-less requests
remain explicit policy changes, not a probe result.

The decision file is `buck-out/.cache-daemon-posture/reapi-job-<job-hash>.json`
(`0600`), written atomically under the root lock. Endpoint/auth identities are
HMACs with a private persisted random key, never raw credentials; filenames
contain only a job-identity hash. Different credentials remain distinct and
cannot silently replace a live daemon's authority. Actual same-daemon policy
mismatches still refuse. A conflicting lease is checked for liveness again
after the awaited probe so an already-exited client cannot cause refusal.

A first-probe fallback visibly warns on stderr with its bounded diagnostic
reason and appends a GitHub step-summary entry when `GITHUB_STEP_SUMMARY` is set.
This explicitly announces that the job retains local execution even after
recovery. Admission evidence records `reapiDecision` as
`first-probe-for-ci-job` or `pinned-from-first-probe`, retaining the original
bounded failure reason on pinned fallback invocations.

Linux quality and the macOS test job run `buck2:cache-posture:ci-test`: the
standalone posture suites exercise process-birth identities and locking with
fake natives, and a real-native regression checks different roots/isolations,
same-daemon refusal, and A's next `audit config` after B changes the shared overlay,
without fleet `gate-slot` or building actions.
`buck2:cache-posture:test` remains the fleet-host suite, including the broader
entrypoint and gate lifecycle tests; its fail-closed gate-slot requirement is
unchanged.

The shared posture and gate-isolation fixtures allocate private per-file run roots
under the checkout's ignored `tmp`, removing each fixture in `finally` and each
file's run root in its own `afterAll`. Both files run in one CI invocation to
exercise cleanup across Bun's shared module registry. This applies to local and
CI imports alike: Bun enumerates
working-directory ancestors on startup, so the size of a shared system temporary
directory must not become part of a fake native command's workload. Test guards
and native admission deadlines remain unchanged.

The repository's own devenv shell and tasks temporarily use Bun 1.4.4 via a local
overlay. This includes the upstream `spawnSync` GC/poll-lifetime fix
([Bun #44581](https://github.com/oven-sh/bun/pull/44581)); it does not change
published package runtimes or consumer overlays. The override preserves the
locked nixpkgs Bun derivation and asserts that it must be removed once the locked
version reaches 1.4.3. Contract generation and freshness checks explicitly retain
the published Bun 1.4.2 runtime because its version is part of the committed
contract fingerprint.

Cache-less commands (`BUCK2_NO_REMOTE_CACHE=1` or native `--no-remote-cache`)
retain the fixed-source/offline posture contract: they remove the RE client
configuration before startup. A test that needs this posture concurrently with
ordinary writers owns a separate project root or daemon isolation. The existing
TypeScript emit/publication regression retains its separate project root and
copies tracked source inputs without `buck-out`, links only host capabilities
and live editor views, and stops its own daemons before removing that root.
Editor publication remains in the original root with its inherited posture.

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
private listener, permits root-authorized uploads, and references the Basic
header variable. Credential values never enter the config file; the daemon
expands the variable at startup. Archive origins do not select the read path.
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
fails closed on REAPI unavailability. If an admitted reader command fails solely
with an RE-client initialization/capabilities/connect unavailable diagnostic, the
launcher records `reader-reapi-unavailable-shadow` evidence and warns that no
rerun happened. The native failure and exit code stand; there is no second
invocation, no cache-posture change, and no admission fallback increment.
This shadow-only observation preserves the strict outage posture. Unknown/mixed
diagnostics, compilation/test failures, authentication/authorization failures,
integrity errors, and writer postures produce no shadow event.
Stdout remains inherited. Supervision applies only when stderr is not a TTY;
terminal invocations and `run`, `install`, and `bxl` execute unchanged without
shadow classification, preserving superconsole and interactive user-binary behavior. The shared
subcommand scan skips global option values, so an isolation named `run` is not a
run command. Captured
stderr is bounded to 256 KiB of bytes before decoding; overflow or signal
termination forbids shadow evidence. The stderr tee advances short writes and waits on
nonblocking backpressure. Launcher interruption cancels a stalled backpressure
wait and disables shadow evidence; a normal native exit does not cancel forwarding.
After normal exit, stderr drains completely before returning the child's result.
A consumer that remains stalled without interruption blocks as native Buck would.
A failed or interrupted output consumer still drains/discards remaining stderr
and reaps the child's final result.

The classifier strips Buck's bracketed timestamps and embedded RFC3339 warning
timestamps, accepts only enumerated progress/statistics lines, and validates every
`Action failed:` block as `remote_action_cache` RE-client initialization followed
by an unavailable capabilities error. Digest identifiers are metadata permitted
only inside a validated block; digest mismatches remain integrity failures.
Non-empty action stdout/stderr rejects shadow classification. `BUILD ERRORS (N)` must match the
summary block count; repeated live failure blocks must match the summary's action
set. The verbatim public CI fixture exercises both live and repeated summary
diagnostics through the launcher's captured native stderr.

### Local Materialization Policy (BUILD.BUCK.REUSE-R08–R10)

```text
cheap file-heavy materialization -> default local executor -> no AC reads/writes
audited compute/verdict action  -> cache_hermetic executor -> root cache posture
```

**BUILD.BUCK.REUSE-DQ04 (resolved):** `pnpm_extract`, `pnpm_store_entry`,
`pnpm_store_scc`, `pnpm_store_view`, `package_tree`, and `runtime_module` execute
locally without remote-cache lookup or upload. Their rules retain `cache_guarded_rule` but do
not admit the `cache_hermetic` constraint; their actions prohibit cache uploads.
The default execution platform has `remote_cache_enabled = False` and
`allow_cache_uploads = False`, independently of the root writer posture.
`local_only` alone is insufficient: it restricts execution, not remote-cache
reads. Compute actions such as `tsgo_emit` retain audited remote-cache admission.
`runtime_module` dereferences each declared runtime source file into an ordinary
artifact; these cheap copies are excluded from the proof and evidence denominator
just like tree/store assembly, without admitting other local compute actions.

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

### Host-local materialization reuse (lever 5a)

This section specifies host-local sibling-worktree reuse under [Reuse Requirements](./requirements.md), especially BUILD.BUCK.REUSE-R03, BUILD.BUCK.REUSE-R05, BUILD.BUCK.REUSE-R07 and BUILD.BUCK.REUSE-T01.
**Design status:** recommendation B was approved 2026-10-24 by Deps Manager (`2078027ff9057be8`) and effect-utils-manager (`edec825400cf32d5`). Archive acquisition is **in progress**, not merged, in [#2101](https://github.com/overengineeringstudio/effect-utils/pull/2101). Extraction replay is **parked/open under DQ08**; its protocol below is not an active design. DQ07 retains the overall fresh-root performance goal but no longer assigns it to lever 5a.
Scope: registered sibling worktrees on the same host/user. Excludes lever 5b's missing arm64 CI writer, remote expanded-tree caching, pnpm GVS implementation, cross-host sharing and automatic retirement of buck-out/editor generations.
The execution/materialization specs link to this contract rather than duplicating its store, lifetime and GC rules.

#### Evidence and constraints

| Evidence                                                                                                                                                                      | Established result                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E01: supplied baseline, Linux arm64 ext4 dev host, main `54eec832`                                                                                                            | main `54eec832`; Linux arm64/ext4 without reflink; target `//packages/@overeng/notion-effect-client:typecheck`; W1/W2 each 522 local materialization actions, +841–844 MB buck-out, 137,330,301 B archive downloads, 14.6–14.8 s cold invocation. Counts: extract 249, entry 241, view 9, package-tree 9, SCC 3, runtime-module 2. Nine additional local TS actions belong to 5b. |
| E02: `buck2/dependencies/defs.bzl:187-207,245-276`; `assemble-store.ts:95-163`                                                                                                | Archives are SHA256/size pinned. Extraction is offline/nonremote. Store entry/SCC assembly already hardlinks declared Buck package files within a root; this is not a proposal to fix per-importer copying.                                                                                                                                                                       |
| E03: reuse `spec.md:159-226`; evidence classifier `genie/ci-scripts/buck2-action-evidence.ts:9-18`                                                                            | Six categories stay excluded from remote reuse; 322 extracts produced 29,423 files/646,157,901 B in the documented lane. Local 7.062 s versus all-hit 1071.022 s motivates retaining local projections. Deferred materialization already defaults on; exported backing roots remain required.                                                                                     |
| E04: `editor-view-sharing.ts:200-226,509-577,590-666,1374-1440`                                                                                                               | Existing same-user SHA256+mode CAS, readonly 0444/0555 blobs, shared Git-common-dir resolver, crash-released flock, guarded hashing, nlink==1 collector with locked recheck.                                                                                                                                                                                                      |
| E05: `editor-view-leases.ts:63-80,180-236,309-340,393-445`                                                                                                                    | Local-filesystem allowlist; OverlayFS unknown. SH reader acquisition and retained EX retirement under CAS fence; persistent control identities; unsafe/unknown never authorizes retirement. Current source also admits local OpenZFS/HFS/ramfs, not merely the initially listed filesystems.                                                                                      |
| E06: `rust/buck2-tools/archive-tool/src/main.rs:114-185,310-359,710-721`                                                                                                      | Normalized extraction, path checks and ordered patches; ordinary extraction files initially writable, executable status retained.                                                                                                                                                                                                                                                 |
| E07: [Store Authority](../../../dependency-materialization/04-store-authority/spec.md#placement), `nix/devenv-modules/tasks/shared/pnpm-task-helpers.sh`; Deps Manager review | pnpm 12.7/v11 has mutable owner-writable CAS, build-mutated GVS slots, explicit prune/nlink protection, unstable SQLite-WAL/msgpackr index and explicit shared/job-local path policy.                                                                                                                                                                                             |
| E08: `buck2/materialization.bzl:40-62,88-176`; `package-tree.ts:278-307,475-523`; `buck2/hermetic.bzl:145-214`                                                                | Runtime copies are explicit; package sources clone/copy; package projection is sandboxed on Linux. CAS must not become an ambient sandbox input.                                                                                                                                                                                                                                  |

Repository citations E02–E08 mean origin/main **54eec832845f0f15065520834802a1244d66b6ae**, paths under `packages/@overeng/buck2-tools/src/` unless qualified.
E01 is supplied benchmark evidence, not independently rerun; a supplied 14-worktree survey is ~1.6 GB/built root, 18.5 GB total, no cross-root hardlink sharing.
The existing host-selected pnpm store is owned exclusively by pnpm and selected by `PNPM_SHARED_STORE_DIR`; lever 4 reuses it without migration/layout-version change, with GVS graph slots under `v11/links`. Unset-variable fallback follows the [Store Authority placement contract](../../../dependency-materialization/04-store-authority/spec.md#placement).

#### Architecture and ownership (BUILD.BUCK.REUSE-R05/R07; BUILD.BUCK.REUSE-T01)

```text
lock/sidecar + declared archive/tool inputs (authority)
  -> Buck archive acquisition helper (owner: Buck tools; #2101 in progress)
      -> existing editor-view file CAS (one owner/collector; shared archive bytes)
      -> adjacent archive metadata + reader controls (Buck-owned disposable hints)
      -> each root's declared archive output (private clone/copy)
pnpm -> PNPM_SHARED_STORE_DIR + globalVirtualStore (owner: Deps Manager; untouched)
```

**Recommendation B:** extend the existing Buck/editor-view content service, not pnpm's store.
There is exactly one pnpm CAS/GVS owner (Deps Manager), and exactly one owner of the existing Buck file CAS (Buck tools/editor-view machinery).
Do not create another pnpm store, peer-resolution database, `node_modules` installation authority, or package-manager invocation.
Buck's generic file CAS contains immutable derived build bytes, including already-normalized/patched files; the authored lock/sidecar and declared tools remain authoritative.
Shared expanded package payloads, extraction/projection helpers using recipe metadata, and recipe-generation maintenance belong only to the parked DQ08 context below; they are not part of the active archive-acquisition design.
**Durable boundary (DQ05, approved):** Buck never reads/links pnpm's index or CAS, including indirect GVS access. Any future lever proposing a pnpm-index reader requires a new Deps Manager review; this approval does not authorize it.
There is **no** cross-pnpm/Buck physical deduplication claim: the same dependency may occupy both authorities once. Measure those bytes honestly.
Deps Manager approved recommendation B on **2026-10-24**, message `2078027ff9057be8`, conditional on megarepo-local placement, the high-water/LRU policy below, and combined incremental-host-byte reporting in [schickling/dotfiles#7407](https://github.com/schickling/dotfiles/issues/7407) verification.

| Alternative                                                                                   | Disposition                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Read pnpm CAS directly                                                                        | Reject for this lever: requires version-pinned WAL/msgpackr reader or another package index; writable pnpm inodes cannot join the readonly Buck CAS. Copying them does not solve ext4 root growth. Never link GVS slots or chmod pnpm CAS. |
| Existing generic Buck file CAS                                                                | Approved: existing lifetime/integrity/GC mechanisms, no pnpm-internal API, dedup across editor and Buck views. Ordinary outputs initially clone/copy; no repository-pinned Buck patch.                                                     |
| Separate Buck package store/daemon                                                            | Reject: parallel owner/collector and a second package-shaped layer without benefit over existing file CAS.                                                                                                                                 |
| Expanded trees in remote cache                                                                | Reject: contradicts measured output economics/E03.                                                                                                                                                                                         |
| Clonefile/reflink where possible, verified copies otherwise                                   | Approved initial ordinary-file strategy; ext4 without reflink reports bytes without a byte target until an upstream-fixed release is pinned.                                                                                               |
| Hardlink writable 0644 Buck outputs; mark ordinary files executable; relink after Buck hashes | Reject: weakens integrity, changes executable semantics, or races Buck's state.                                                                                                                                                            |

#### Native Buck safety gate (BUILD.BUCK.REUSE-R05/R07)

```text
UNMODIFIED PIN: CAS 0444 --hardlink--> buck-out --Buck normalization--> SAME INODE 0644
CURRENT 0555:   CAS 0555 --hardlink--> buck-out --OR 0444-----------> SAME INODE 0555
FIXED RELEASE: CAS 0444 --hardlink--> buck-out --Buck hashing-------> SAME INODE 0444
```

**Unmodified pinned Buck is NOT safe for ordinary-file CAS hardlinks.**
`nix/buck2.nix:13-18` pins release 2026-09-01, upstream commit `be6971d47dcc835b7356e1698b23039ffee4f4c2`.
Upstream [`app/buck2_execute/src/entry.rs:76-103,280-291`](https://github.com/facebook/buck2/blob/be6971d47dcc835b7356e1698b23039ffee4f4c2/app/buck2_execute/src/entry.rs#L76-L103) computes `mode | (is_directory ? 0755 : any_execute_bit ? 0444 : 0644)` and normalizes before hashing. Thus regular **0555 OR 0444 = 0555**, with no chmod when unchanged; ordinary **0444 OR 0644 = 0644**.
**DQ06 resolved:** submit the upstream readonly-preservation PR now; **no repository-pinned patch or Buck source builds** (the three-platform prebuilt-release distribution remains authoritative). Until a fixed upstream release is pinned, ordinary files MUST use clonefile/reflink where available, otherwise verified independent copies. Executable 0555 files MAY be hardlinked on admitted same-device filesystems.
Enabling executable hardlinks requires a test proving the same CAS/output inode remains **0555 after real Buck finalization**, with unchanged content; source inspection alone is not that test.
Ordinary-file hardlink mode is deferred until the upstream fix enters the pin and is enabled in a separate small PR with equivalent 0444/finalization proof. Never mark an ordinary file executable to bypass normalization.

Helpers MUST never write/chmod/utime a linked payload; apply patches/transforms to private staging before CAS admission. CAS modes are canonical 0444 or 0555; independent buck-out copies may receive Buck's normal 0644 mode without changing C.
Directories and symlinks remain root-owned metadata. Rebuilds replace/unlink output pathnames, never reopen linked files for writing.
Upstream [`local.rs:891-990`](https://github.com/facebook/buck2/blob/be6971d47dcc835b7356e1698b23039ffee4f4c2/app/buck2_execute_impl/src/executors/local.rs#L891-L990) hashes disk outputs then declares them existing; SHA256/size/executable identity, not inode/nlink, must remain the same for warm/cold/fallback results.
[`clean_output_paths.rs:61-70`](https://github.com/facebook/buck2/blob/be6971d47dcc835b7356e1698b23039ffee4f4c2/app/buck2_execute/src/execute/clean_output_paths.rs#L61-L70) removes previous outputs; Unix [`fs_util.rs:308-317,500-523`](https://github.com/facebook/buck2/blob/be6971d47dcc835b7356e1698b23039ffee4f4c2/app/buck2_fs/src/fs_util.rs#L308-L317) unlinks, without file chmod. [`clean.rs:247-268,650-691`](https://github.com/facebook/buck2/blob/be6971d47dcc835b7356e1698b23039ffee4f4c2/app/buck2_client/src/commands/clean.rs#L247-L268) kills the root daemon and removes root paths, not the external CAS.
Inference: These paths support unlink-safe lifetime for admitted executable hardlinks now and ordinary hardlinks after the fixed release; end-to-end proof remains a release gate, not a blanket claim about every Buck feature.
Keep deferred materialization and all `read_roots`/`other_outputs` declarations. Host cache presence never stands in for a declared/materialized artifact. `buck2 clean` may lower nlink but cannot delete siblings' content.

#### Threat model and incident recovery (BUILD.BUCK.REUSE-R05/R07)

```text
chmod/write through ANY CAS hardlink -> shared inode -> every worktree/editor/cache reader
mode/digest alarm -> incident -> quiesce -> hash-verified mode repair OR quarantine
```

The boundary is same-user host-local build content, not protection against malicious code running as that user or root. Readonly mode is an operating contract: any hardlink carries a **host-wide blast radius** if a tool/user chmods or writes through any alias, including editor snapshots and current executable-only links.
Manager-reported incident, **2026-10-24**: `chmod -R u+w` on a worktree after failed teardown made approximately **28.8k shared blobs 0644**. Inode tracing found editor-view backing links, not buck-out; this incident is separate from the independently proven Buck normalization issue.
Never recursively chmod a worktree containing shared content to make teardown succeed. Cleanup may change only proven private directory modes and unlink owned payload pathnames; writable build scratch must use independent inodes.
Collector/admission mode checks detect noncanonical 0444/0555 state, stop trusting affected content and report an **incident**, not an eviction miss; every link acquisition also verifies digest/size/mode with existing guarded inode proof.
Recovery MUST be explicit and **quiesced across all readers/writers and aliases**, with no automatic repair during a build. Hash each affected inode; if SHA256 matches its address, restore mode from the validated `-0444`/`-0555` suffix. Otherwise quarantine, **never delete**, preserve the bad inode/evidence, and invalidate/rebuild affected derived views before resuming. Restoring one mode without quiescence does not revoke an existing writable descriptor.

#### Parked extraction replay (BUILD.BUCK.REUSE-DQ08; open)

The APFS prototype eliminated actual extraction and download work but did not improve elapsed time: the controlled legacy run took **45.9 s**, the first warm replay **118.6 s**, and the settled warm replay **53.8 s**. The settled run used metadata proofs for all 250 recipes, yet installation still required **25,983 per-file clones** of **510,611,609 bytes**. Native evidence retained identical RE action digests for all **272 downstream consumers** in cold and warm comparisons. These are prototype observations, not acceptance results.

Measured **2026-10-24**, comparing the slice 2 prototype at
`46b29545fb52b644e5b742fe28dfc87d8f65265e` with the slice 1 baseline
([#2101](https://github.com/overengineeringstudio/effect-utils/pull/2101)) at
`1cda58b4067211b1b3eebc0fd5960d242375fed6`, in the same controlled capability
profile. The primary run receipt records both revisions and the **45.942 s**
baseline; the settled prototype summary records **53.784 s**. Its replay receipts
record the **25,983 clones / 510,611,609 bytes**, and native consumer-action proof
records the **272 unchanged downstream digests**. These measurements describe this
revision pair, not the default capability profile or a later implementation.

Profiling identified per-file clone/open/identity work, rather than proof-file reads or leases, as the dominant replay cost. A two-generation reproduction also showed that adding shared payload pins and removing private extraction links changes ctime and invalidates recipe proofs. On non-reflink ext4, ordinary-file hardlinks remain prohibited; replay would copy and hash approximately 510.6 MB rather than decode approximately 135.8 MB of archives, with no measured ext4 win.

**Decision:** park extraction replay. Recursive tree clone is rejected, not a pending prototype. Reopening requires the upstream [facebook/buck2#1590](https://github.com/facebook/buck2/issues/1590) fix to enter the repository's Buck pin, followed by a separately proved ext4 ordinary-file hardlink mode and renewed acceptance measurements. Archive acquisition in #2101 remains independent.

##### Parked recipe protocol (not active design)

The following recipe-generation protocol is retained as investigation context only. It is not an implementation commitment or authorization to enable replay; reopening DQ08 requires reviewing it against the then-current archive acquisition and maintenance contracts.

```text
C = defaultEditorViewContentStore(root)       # unchanged resolver/override
C/<hh>/<sha256>-(0444|0555)                   # EXISTING file CAS format
M = C + '.buck-materialization-v1'           # adjacent metadata, NEVER inside C
M/.store/recipe-<recipeSha256>/manifest.json  # immutable recipe generation
M/.store/recipe-<recipeSha256>/pins/<blobKey>  # one hardlink per distinct payload
M/.leases/recipe-<recipeSha256>.lock          # persistent reader control
```

Buck tools owns M and calls the existing CAS service for C; one CAS flock/collector, no independent blob deletion code.
M uses the existing per-generation lease primitive/control validation, with its own explicit root inventory; it is NOT silently added to editor publication or editor budget's eviction scan.
Each recipe publication/retirement has a crash-released per-recipe flock; ordering is recipe lock -> CAS metadata fence -> generation lease. Never hold CAS lock across network, extraction or full hashing.
Recipe key = SHA256 of canonical UTF-8 JSON array `["effect-utils/buck-materialization-recipe/v1", toolClosureDigest, archiveSha256, stripPrefix, orderedPatchSha256s]` (no whitespace; lowercase hex; declared capability closure digest includes tool/protocol changes).
Only extraction recipes are cached as whole trees; entries/SCC/views continue to derive peer/workspace edges from declared Buck graph inputs in each root. Thus no root-specific absolute paths or peer graph are stored in a package cache.
Manifest schema: `{"schema":"effect-utils/buck-materialization-tree/v1","recipe":<full recipe array>,"entries":[...]}`.
Entries, sorted by UTF-8 path bytes, are exactly `{"path":p,"file":{"sha256":h,"size":n,"mode":"0444"|"0555"}}`, `{"path":p,"directory":true}`, or `{"path":p,"symlink":relativeTarget}`; one entry per path, explicit directories, empty tree rejected.
Paths are normalized relative UTF-8, no empty/dot/dotdot components, backslash, NUL/control bytes, duplicate paths, or traversal through a symlink. Symlinks must resolve inside the extraction tree under existing archive validation.
Repository-private `effect-utils/` schemas are owned by Buck tools, case-sensitive exact v1 identifiers; hashes are 64 lowercase hex digits, mode is not inferred from filenames. Unknown version/fields or key/recipe disagreement invalidate reuse (no best-effort decode). Example valid blob: `ab/ab<62 lowercase hex digits>-0444`; `AB…`, `-0644`, and `../x` are invalid.
Breaking formats get new versioned namespaces; all state is disposable, no in-place migration or pnpm index mirror.

1. Acquire/verify the declared archive (next section); compute the extraction recipe from declared inputs.
2. Hit: acquire a SH generation lease under C's fence, validate manifest/key, verify each selected blob's digest/size/mode/owner/inode with no-follow descriptors and before/after identity checks; materialize into private output staging using the file-mode/filesystem strategy below. Fence source-pin/link changes with CAS GC; retain source pins/lease through clones/copies.
3. Miss: extract and patch with the existing attested archive tool into private staging; normalize privately; admit verified files through C's existing publication protocol, then materialize outputs with the same strategy. A warm replay never decodes the archive, even when copying ordinary payload bytes.
4. Publish generation manifest and distinct-blob pins atomically only when complete; concurrent identical writers accept a verified winner. Fsync payloads/manifest and parent directory before success; incomplete staging is never a hit. Hash outside the lock, recheck verified inode identity under it.
5. Atomically promote root-local staging to the declared Buck output; retain the SH generation lease until output references are installed. On partial failure unlink only private staging; return a miss if a concurrent collection removed the recipe before acquisition.
6. Existing entry/SCC assembly may retain its within-root hardlinks to declared private extraction outputs; these are not CAS aliases. Any direct CAS reference follows the executable/ordinary strategy below; never chmod a CAS-linked inode. Root-specific symlinks are regenerated exactly as today.
7. Package-tree actions keep Linux sandboxing and existing declared inputs. A trusted outer materialization finalizer handles their completed outputs **after** sandbox exit and **before** Buck hashing; it verifies byte identity and applies the same safe CAS-to-output strategy, never exposes C to the sandbox. Small source/transform/runtime copies remain explicit; do not copy then deduplicate an entire warm dependency tree.

#### Shared archive acquisition (BUILD.BUCK.REUSE-R05/R07)

Archive acquisition is independent of the parked recipe protocol: C is the existing editor-view file CAS, resolved by the content service; M is its adjacent Buck-owned archive metadata/control namespace, never inside C. Archive generations and their leases/pins below do not require recipe manifests, expanded trees, or a recipe-aware maintenance scanner.

```text
expected (sha256,size) -> C blob hit -> verified output reference
                      -> miss -> HTTPS fetch -> private temp -> verify -> atomic admission
```

Owner is the same Buck content service, not pnpm. Store archives as ordinary 0444 file blobs in C; expected SHA256 is already the CAS address, so no URL-to-package index is needed.
For public registry archives, replace native per-root `download_file` with a local nonremote acquisition helper; retain current sidecar SHA256 and positive size checks and HTTPS URL restrictions. Root outputs remain declared `package.tgz` artifacts.
Before network, validate a digest/size hit under the same admission/lifetime protocol; a miss downloads once into a private no-follow/exclusive temp, verifies full digest/size, then atomically publishes. Coalesce concurrent downloads with a crash-released digest lock outside CAS exclusion; recheck after acquiring it.
Digest mismatch or untrusted/writable existing blob is an integrity error, not a silent overwrite or cache miss. Never cache credentials or use URL spelling as identity. Different bytes cannot share an integrity key.
Private `file:` products and declared Nix archive roots retain their existing **Nix-only** acquisition authority; never use this cache to substitute for a missing private capability.
Retain each archive through a generic `M/.store/archive-<sha256>/pins/<sha256>-0444` generation; the name, verified digest and expected declared size suffice, with no package index. Archive generations use persistent, validated reader controls independently of any extraction recipe: readers retain SH through output installation; publication and retirement use generation exclusion plus the C fence, with retirement retaining nonblocking EX until its pins are removed. This pin is required because ordinary buck-out copies do not retain the CAS inode. Recipe-generation controls remain parked under DQ08.
Hold its SH lease through output clone/copy/link completion; pressure maintenance may retire only unleased archive generations and then collect nlink==1 blobs. A cache-empty host downloads once; an intact warm archive generation yields zero network bytes, while eviction yields a normal miss.

#### Filesystems, leases and collection (BUILD.BUCK.REUSE-R07; E04/E05)

| Condition                                                                   | Required behavior                                                                                                                                                             |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admitted local FS, same device, current pin, regular executable 0555        | MAY hardlink only after the real Buck-finalization mode-preservation test passes.                                                                                             |
| Ordinary 0444, current pin                                                  | Clonefile/reflink to independent inode where supported, otherwise verified private copy. Archive acquisition is in progress in #2101; extraction replay is parked under DQ08. |
| Admitted local FS, same device, upstream-fixed pin and separate enabling PR | MAY hardlink ordinary 0444 after equivalent finalization proof; executable semantics stay unchanged.                                                                          |
| EXDEV, no clone support, or link-count limit                                | Verified private copy; no per-device replica store. Record reason/bytes; ext4 without reflink has reporting-only byte budgets until fixed pin.                                |
| Unknown FS (including OverlayFS) or unsupported platform                    | Disable host CAS use, publication and automatic collection for that invocation; run existing private extraction/acquisition/copy path. Unknown does NOT authorize cleanup.    |
| Unsafe ownership/path, corrupt content/control, digest drift                | Fail integrity admission; do not “fallback” past corruption. Separate explicit quiesced repair from build execution.                                                          |

“Fail closed” preserves #1990's destructive-retirement boundary: unknown lease evidence never authorizes deleting a generation. Copy fallback means **not entering** the sharing subsystem, not treating unknown locks/nlink as safe. Existing editor-view leases remain independently fail-closed; this does not make editor publication succeed on unsupported filesystems.
For admitted local C but EXDEV output, hold a source lease/pin through the copy; after it completes the private output needs no CAS lease. Do not collect C unless its own filesystem is positively admitted local.
M's explicit maintenance retires only SH-unleased **archive generations** with retained EX, under archive-generation/C fences; rename to private garbage while fenced, unlink its pins afterward, preserve lease-control tombstones forever. Unknown/held means retain. Recipe-generation retirement and mixed archive/recipe maintenance dispatch are not active behavior; they require a DQ08 reopening.
Extend **the existing** `collectEditorViewContentStore` with the high-water/LRU candidate selection below, not a second collector: validate candidate digest/ownership/mode, delete only nlink==1, recheck unchanged inode+nlink under C flock. Existing editor generations, M pins and any buck-out hardlink all count equally. Explicit full collection remains available; automatic pressure passes stop at the high-water mark.

##### Capacity policy (DQ05 approval condition)

```text
above high water -> retire unleased archive pins -> LRU of validated nlink==1 blobs
still above due to references -> referenced-bytes-over-cap -> report/alert; retain
```

C and adjacent M MUST live on the existing megarepo filesystem, using the Git-common-dir resolver; an override must remain on that filesystem. No standalone-home fallback store is authorized for this host-sharing mode.
Declare the high-water mark centrally in the Buck tools content-service configuration: `EDITOR_VIEW_CONTENT_STORE_HIGH_WATER_BYTES`, a positive decimal byte count, default **4294967296 (4 GiB)**. The host's shared environment may override it; all editor/Buck publishers and maintenance resolve the same C-scoped value, never a per-worktree quota.
This is a high-water trigger, NOT a hard allocation/build-admission limit. On publication completion and each host maintenance pass, census C's unique allocated blob bytes; report M's metadata/control/pin-directory allocation separately and in the combined host total.
If above the mark, first retire eligible unleased M archive generations under their EX/fences, releasing only their cache pins, then select unreferenced blobs by oldest successful-use time until at/below the mark or no eligible blob remains. Extending this retirement to extraction recipe generations is parked under DQ08.
Record LRU access hints outside readonly C payloads, in M's atomic replaceable metadata, at successful acquisition/publication; never utime/chmod linked blobs. Missing hints sort oldest; hints rank candidates but never authorize deletion. Recheck validated inode identity and **nlink==1** under the existing collector fence before each unlink.
Referenced blobs (including buck-out/editor links and retained/leased archive pins) are **not evictable**. If their allocated bytes exceed the mark, emit/report the exact state `referenced-bytes-over-cap` with cap, total, referenced and reclaimable bytes; host maintenance alerts on that state. Do not delete referenced content, fail a build, or weaken leases to enforce the cap.
Publish the pressure receipt with [schickling/dotfiles#7407](https://github.com/schickling/dotfiles/issues/7407) verification and host maintenance output; the signal is operational pressure, not an integrity failure. Inability to inspect safely remains fail-closed for deletion.
Evicted/missing archive generations or payloads are a normal acquisition miss: fetch and verify the declared archive through the acquisition contract, never substitute another origin. Digest mismatch or writable/unsafe content remains an integrity error, not an eviction miss. Reconstruction of expanded package trees from a recipe miss, and the obligation never to return a partial replay, apply only if DQ08 reopens.
A private cloned/copied buck-out archive needs no continuing source lease after installation. Existing admitted hardlinked outputs remain actual references, not external symlinks; CAS GC never retires editor or buck-out roots. Hardlinked replay outputs are parked under DQ08 and its native safety gate.
Crashes release flock/SH via descriptor close; linked outputs/pins survive and keep bytes alive. Reuse the existing process-incarnation staging cleanup/dirty-store repair; never age-delete a live/unknown generation. A missing whole cache is rebuildable; malformed partial state is not trusted.
Before enabling sharing on a host with writable legacy CAS blobs, the quiesced digest-verified repair/quarantine procedure above is required; never repair by chmodding live linked payloads or deleting mismatched blobs.

#### Acceptance and measurement (BUILD.BUCK.REUSE-R03/R07; DQ07)

```text
W1 populates new cache -> new W2/W3 roots, same inputs/host -> compare incremental host cost
```

Correct [schickling/dotfiles#7407](https://github.com/schickling/dotfiles/issues/7407)'s metric: **zero downloaded archive bytes per intact warm sibling** is lever 5a's acquisition target. **Zero actual archive extraction/patch executions applies only when extraction replay is active**; replay is currently parked under DQ08. Low payload-write/allocation budgets remain conditional on ordinary-hardlink mode or clone-capable filesystems; ordinary-copy ext4 reports bytes without those targets.
Native local action counts are not success criteria. Extraction and metadata projections may still execute; a future replay must report actual work rather than claim action suppression or relabel exclusions.
Keep native category counts separate from helper counters: archive hits/misses, actual archive decodes/patch runs, bytes downloaded, payload bytes newly written to buck-out/C, cloned/linked/copied files, reason-coded fallbacks, and materialization critical-path wall time (not summed overlapping action durations). Recipe hit/miss counters apply only if DQ08 reopens.

| Same-input fresh-sibling metric                                      | Supplied baseline                                       | Initial accepted target (DQ07)                                                                                                                                          |
| -------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actual archive extraction/patch executions                           | 249/root                                                | **0/root only when extraction replay is active** and W1's recipe generations remain intact; currently parked under DQ08                                                 |
| Registry archive bytes downloaded                                    | 137,330,301/root                                        | **0/root** on intact warm cache                                                                                                                                         |
| Physical growth of union of all roots' buck-out + C + M + pnpm store | +841–844 MB/root (buck-out only measured)               | **<=100 MiB/root only in ordinary-hardlink mode or clone-capable FS**; ext4 without reflink reports bytes without target until upstream-fixed pin; pnpm delta remains 0 |
| Materialization payload bytes newly written (not hashed/read/linked) | Not separately instrumented                             | **<=20 MiB/root only in ordinary-hardlink mode or clone-capable FS**; ordinary-copy ext4 reports actual bytes without target                                            |
| Cache-empty W1 physical union growth                                 | +841–844 MB buck-out; external-store delta not measured | Report archive+expanded CAS, metadata/pins and buck-out union, including unavoidable ordinary-copy duplication; no initial W1 byte target                               |
| Full cold-root target elapsed, same nine TS actions                  | 14.6–14.8 s                                             | **Overall goal: <=12 s median over five fresh roots**, not a lever 5a target; selected local/remote levers and platform limits are recorded in DQ07                     |
| Native local materialization actions                                 | 522                                                     | Report unchanged count honestly; no numeric reduction required                                                                                                          |

The **overall <=12 s median over five fresh roots remains the goal**, not a lever 5a acceptance target or a measured speedup. The completed fresh-root action-category breakdown selects store-entry projection and the serial TS emit chain as the performance drivers; DQ07 records the chosen levers and platform limits. Conditional byte budgets above remain initial budgets, not established savings.
For that overall goal, use the exact target/revision/platform and comparable unloaded conditions from E01; five independent fresh roots, cold daemon/root state, warm applicable shared cache, retain W1, no intervening explicit collection; publish all five times and median, current cache/tool identities and native logs. Do not call this cold-disk/page-cache evidence. Replay-specific acceptance applies only after DQ08 is reopened.
Measure allocated blocks once per `(st_dev,st_ino)` over the complete union, not a sum of separate `du` invocations; publish apparent bytes and nlink/inode samples separately. For APFS clones report allocation with clone-aware evidence or label physical savings unmeasured. Count writes separately from allocation.
After removing W1, W2 must still typecheck/read complete content. After all roots/M archive pins/editor generations release, explicit collection must reclaim only unreferenced blobs. Concurrent publication/GC, crash mid-publication, changed archive/tool/mode, corrupt blob, EXDEV, OverlayFS, clean/stale clean, and deferred final-output materialization are mandatory acquisition correctness cases. Changed patches and recipe-generation pin/reconstruction cases additionally apply only if DQ08 reopens.

#### CI posture and cutover

Host sharing is disabled by default in GHA and `PNPM_JOB_LOCAL_STORE=1` jobs, including OverlayFS; use current declared archive acquisition/extraction and sandboxed projections, with no host-cache scan or global pnpm store access. `CI=true` alone is not pnpm's job-local-store selector (E07).
Known-local CI can opt in only after explicit owner policy and the same native/FS/integrity gates; correctness must not depend on a prepopulated cache.
Keep remote category exclusions and consumer cache policy unchanged. Update generated rule declarations through their generator, never hand-edit generated `buck2/dependencies/BUCK` (source header at :1-7).
Archive acquisition cutover is in progress in #2101, with fallback as an explicit execution mode, not a competing legacy store. Extraction/projection replay cutover is parked under DQ08. No migration of pnpm state or existing editor generation identities.

#### Design decisions and open questions

- **BUILD.BUCK.REUSE-DQ05 Store boundary / Deps Manager (resolved):** Recommendation B approved **2026-10-24**, message `2078027ff9057be8`: existing generic Buck CAS is not a second pnpm store. Conditions are megarepo-filesystem placement, declared high-water/LRU of nlink==1 blobs only with reported/alerted referenced-over-cap state, durable no-pnpm-index/CAS boundary, and combined incremental host bytes per new worktree in [schickling/dotfiles#7407](https://github.com/schickling/dotfiles/issues/7407) verification.
- **BUILD.BUCK.REUSE-DQ06 Native safety (resolved):** effect-utils-manager GO **2026-10-24**, message `edec825400cf32d5`: upstream readonly-preservation PR now; no repository-pinned patch/source builds. Current ordinary files clone/reflink or private-copy; 0555 MAY hardlink only after finalization test. Ordinary hardlinks require an upstream-fixed pin and separate small enabling PR.
- **BUILD.BUCK.REUSE-DQ07 Budgets and lever selection (resolved; implementation in progress):** Zero downloaded archive bytes per intact warm sibling remains lever 5a's target. Zero actual extraction/patch executions is conditional on active extraction replay, currently parked. The overall <=12 s median over five fresh roots remains the goal but is no longer a lever 5a target. <=20 MiB writes/<=100 MiB growth remain conditional on ordinary-hardlink mode or clone-capable FS; ordinary-copy ext4 reports bytes without those targets.
  - **Evidence:** macOS APFS, `origin/main` revision `9af34ef5`, three loaded fresh roots, target `//packages/@overeng/notion-effect-client:typecheck`. `pnpm_store_entry` accounts for 242 actions and approximately 60% wall share, is the largest block on the critical path, and has runtime approximately linear in file count. The serial `tsgo` emit chain is the other driver. Materialization/extraction and analysis/daemon overhead are not the drivers. Loaded-root evidence identifies costs; it does not establish the unloaded five-root acceptance median.
  - **Selected levers:** store-entry projection without redundant filesystem operations (in progress); a native store-entry implementation only if that optimization leaves more than 50% of the variable cost; and remote-cache hits via Rust step 2 / q32 on Linux only. On macOS, TS/package/store actions are not AC-eligible and their keys cannot match Linux, so the 12 s goal there can only be reached through local levers.
  - **Rejected levers:** persistent worker, concurrency tuning, analysis/daemon caching, and extraction replay.
- **BUILD.BUCK.REUSE-DQ08 Extraction replay (open; parked):** APFS settled replay was slower than the controlled legacy path (53.8 s versus 45.9 s), despite zero extractions/downloads and unchanged downstream action digests. Tree clone is rejected. Reopen only after upstream facebook/buck2#1590 enters the Buck pin, then separately prove ext4 ordinary-file hardlink safety and performance. The retained recipe protocol is parked investigation context, not active design.

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
Without `WATCHMAN_SOCK`, an un-niced client may spawn its default Watchman
service on demand on Linux and Darwin, including job-local macOS CI runners.
A client with positive niceness always uses `--no-spawn`: it may connect to an
already-running service normally, but must not create a shared daemon that
inherits the gate's reduced priority for its lifetime. An explicit socket also
uses `--no-spawn` regardless of priority, preserving service ownership.
Priority is diagnosed only from evidence. Either Watchman reports its own
startup priority refusal, or a niced `--no-spawn` probe failed silently and a
follow-up client-local `get-sockname` (which never spawns or connects) shows
the computed default socket does not exist: the real client exits without any
output when `--no-spawn` finds no service, and that silence alone is not
evidence. Admission then fails closed with the nice value and remediation:
start Watchman un-niced (`watchman get-sockname` outside the gate), or
provision the host service. A niced failure against an existing but
unreachable or permission-denied socket, a missing or unrunnable executable,
and every other failure keep their genuine service/executable diagnosis.
Consumer admission never relaxes the shared service's
`min_acceptable_nice_value` (default 0).

Private test-owned Watchman instances use a fixture-only global configuration
through `WATCHMAN_CONFIG_FILE` with `min_acceptable_nice_value = 19`; their
isolated HOME prevents user configuration from overriding that setting, and
the regression spawns its private service explicitly at `nice -n 19`, so the
exemption is asserted regardless of the runner's own priority.
The exemption never reaches a shared default service. Source authority:
[`WatchmanConfig.cpp` global loading](https://github.com/facebook/watchman/blob/v2026.07.27.00/watchman/WatchmanConfig.cpp#L27-L68)
and [`main.cpp` priority refusal](https://github.com/facebook/watchman/blob/v2026.07.27.00/watchman/main.cpp#L87-L107).
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
explicitly cache-disabled invocations can bypass the JavaScript launcher within
the remaining probe lifetime; the key includes config contents, arguments, working
directory and exported environment. Cache-enabled readers return through the
launcher so execution remains supervised. Writer credentials, includes and external
mode files bypass that fast path. Inside gate-slot, an outer shell retains cleanup ownership
even when arguments are cached: it waits for the native client and stops only
the selected idle daemon, leaving all local build work in the job's cgroup.
The [wrapper lifecycle contract](../../../../README.md) defines signal handling,
concurrent-client protection and the residual status-to-kill race.

Launcher diagnostics, including watcher migration and admission helpers, use
`node:fs` synchronous descriptor writes rather than Bun's process streams.
At startup the launcher captures fd 0/1/2 file status flags through
`fcntl(F_GETFL)`, then restores and reads them back immediately before native
`execve`. A header-free C shim exposes fixed-arity get/set functions: calling
variadic `fcntl` directly through a fixed-arity FFI binding is not ABI-correct
on macOS arm64. Nix builds the shared library once and fixes its immutable
installed path in the packaged launcher. Packaged invocations only `dlopen`
the library; no compiler or host SDK is needed at runtime. Source execution
loads the same library from the devenv-declared `BUCK2_STDIO_LIBRARY` path,
avoiding runtime compiler and libc linker discovery during bootstrap.
Readback compares status options but excludes macOS's kernel-only
`FWASWRITTEN` bookkeeping bit, which changes when a descriptor is written and
cannot be reset with `F_SETFL`; raw flags are still captured and restored.

Closed inherited descriptors are skipped. A protection load or restoration
failure attempts one best-effort synchronous warning and still executes native
Buck, even if inherited stderr is closed or cannot accept the warning.
Synchronous diagnostics are the primary fix and this defence must not block
builds. The launcher preserves intentionally non-blocking caller descriptors
rather than unconditionally forcing blocking mode.

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

Admission is a reachability snapshot. The pinned native client has ten hard-coded
connection attempts with 45 seconds of cumulative backoff and no configurable
startup fallback. After this fails, eligible readers record the strictly classified
shadow observation described above. Every native failure remains final.

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
native per-command event sink -> allowlisted incremental projector -> atomic sanitized shard
expected native IDs + completed shards -> job finalizer
  +-> buck2-cache-evidence.json (compact, <=64 representatives)
  +-> buck2-cache-actions.jsonl.gz (every first action end)
  +-> buck2-cache-proof-manifest.json + buck2-cache-warm99.json
writers + explicitly expected fresh readers -> warm99 per-lane evaluator
```

CI retains `buck2-cache-evidence-<job>[-<matrix-index>]-<run-attempt>` artifacts
for 90 days, including complete action evidence for the entire proof review
window. Each upload contains the compact summary, complete compressed action
stream, sanitized shards/index, warm99 report, and proof manifest. No raw event
sink or private native-path registry is uploaded. The compact summary remains schema
version `1`: complete native outcome `counts`, per-build-ID `invocations`, and at
most 64 representative `actions`. Its existing `droppedActionCount` continues
to describe omitted **representatives**, not missing full-artifact rows.
Populate and replay invocations retain proof context labels; repeated native
logs are deduplicated by build ID, preserving the first context.
Summary and per-invocation `excludedByDesign` contain
`{ "local-materialization-policy": <count>, "darwin-unsandboxed": <count> }`.
Darwin TS execution uses the named exclusion defined by
[the execution policy](../05-execution/spec.md#typescript-containment-and-platform-admission-buildbuck-r04):
it runs locally but cannot enter shared-cache or hermetic shared immutable-store
admission. Worktree-local editor snapshots remain reusable on Darwin; this
exclusion does not alter existing npm/archive or Nix product boundaries.
Native `counts` still retain every observed outcome; the exclusion counters
are a separate policy axis, not an alternative execution-kind mapping.
Retained schema-1 full artifacts without policy fields derive exclusions from
their complete category rows. Older bounded summaries may omit
`excludedByDesign`: their sampled rows cannot reconstruct a complete total,
so absence means unavailable, not zero. New collectors always emit the counters.
Retained counters predating Darwin-specific categories decode a missing
`darwin-unsandboxed` key as zero; complete artifact rows must agree with that
count. New collectors always emit both keys.

Admission evidence is independent of native execution evidence. Before writer
fail-closed handling, every direct invocation that probes cache appends a UTF-8
JSONL row to `${CI_BUCK2_CACHE_EVIDENCE_PATH}.admission.jsonl`, with the authoritative
`CacheAdmissionInvocation` shape:

```json
{
  "invocationId": "9552ef6c-294e-4a51-9100-9006d6f2c343",
  "admissionFallbacks": { "reapi": 0, "archiveOrigin": 0 },
  "admissionRetrySuccesses": { "reapi": 1, "archiveOrigin": 0 }
}
```

New admission writes use only the repository-local, case-sensitive event
`reader-reapi-unavailable-shadow`, requiring `admissionFallbacks.reapi = 0`
and a `shadow` payload. It enriches the original admission using the same native
`invocationId`; it never invents a second invocation or claims a fallback occurred.
The collector merges a base row and its matching shadow row in either order,
deduplicates identical observations, and rejects conflicting admission or shadow
payloads. Rows without an event remain readable.

The decoder also retains the historical `reader-reapi-unavailable-rerun` event
as read-only measured evidence: it requires `admissionFallbacks.reapi = 1` and
no `shadow` payload, and projects `legacyRerun: true`. Its original and rerun
invocation IDs and measured fallback count remain distinct and unchanged through
daily joins and reprojections. The launcher never emits this historical event;
it cannot be reconstructed from a hypothetical shadow observation. Old-named
rows carrying shadow payloads, malformed historical rows, and unknown events
are rejected.

The shadow payload contains only bounded classification tags and numeric metadata:

```json
{
  "cause": {
    "capabilitiesUnavailable": true,
    "connectRetry": true,
    "clientInitialization": true,
    "connectUnavailable": false,
    "transportMessage": "tls-handshake-eof"
  },
  "command": { "subcommand": "build", "argumentCount": 8 },
  "nativeExitCode": 1,
  "durationMs": 47000,
  "failedActionCount": 1,
  "wouldDisableRemoteCache": true
}
```

`cause` records which accepted diagnostic line classes matched. `transportMessage`
is one of `tls-handshake-eof`, `transport-error`, or `none`, never raw error text.
`subcommand` is one of `build`, `test`, `audit`, `cquery`, `uquery`, `aquery`, or
`targets`; `argumentCount` counts native arguments without retaining their contents.
`nativeExitCode` is 1–255. Durations and counts are nonnegative safe integers;
`durationMs` measures native startup through exit, excluding subsequent output
draining. `failedActionCount` is the validated `BUILD ERRORS` count, or zero for
standalone client-init failures. `wouldDisableRemoteCache: true` records that a
hypothetical no-cache invocation would disable both reads and uploads; no such
invocation executes. No target names, raw arguments, environment, addresses, or
credentials enter this payload.

An REAPI fallback may include `reapiFailure: { class, phase, elapsedMs, deadlineMs }`,
including when admission reuses a cached negative probe. `class` is one of
`configuration`, `dns`, `tcp`, `tls`, `transport`, `deadline`, `auth`, `http`,
`grpc`, or `protocol`; `phase` is `configuration`, `dns`, `tcp`, `tls`, or
`response`. Timings are nonnegative safe-integer milliseconds. Unknown categories
or invalid timings reject the row. No free error text, address, host, or credential
is retained. Older rows without this optional field remain valid.
The summary's `reapiFailures` array groups deduplicated diagnostic-bearing rows
by class/phase, retaining `count` and `maxElapsedMs` per pair. Missing historical
diagnostics do not imply a zero failure count. Retained aggregate fields must
agree with their invocation rows.

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
`admissionRetrySuccesses` (endpoint-wise sums across those rows), and
`admissionFallbacks` (endpoint-wise sums of admission decisions). Current
invocations probe REAPI only; archive acquisition does not participate in
endpoint admission. Retained `archiveOrigin` fields describe historical
archive admission and acquisition evidence, not an active archive read path.
When historical acquisition reason counts are present, the historical
`admissionFallbacks.archiveOrigin` aggregate also includes those counts.
Each probed endpoint counter in an admission row is 0 or 1: healthy first
attempts have zeroes, failure of both attempts records one fallback, and a
successful second attempt records one retry success without a fallback. A
reused cached failure still records one fallback for that invocation; reused
cached health records no retry success. An endpoint not probed has zeroes.
Admission rows describe admission decisions, not action-cache misses or
native upload failures, and do not enter the warm99 action denominator.
The sidecar survives devenv task boundaries and is consumed into the compact
summary, not uploaded as a separate raw artifact. Collector finalization writes
fallback counts and invocation IDs to `GITHUB_STEP_SUMMARY`; the existing stderr
warning remains available at invocation time.

When host sharing is disabled or its private fallback is selected, standalone
pnpm acquisition uses native Deferred download actions rather than `pnpm_archive`
commands. These actions verify the canonical registry download against its
declared SHA-256 and byte size; they are not RE CAS reads or command-action cache
hits. Warm materialized archives need no transfer, while fresh roots on that
native path fetch registry bytes.
The [host-local materialization contract](#host-local-materialization-reuse-lever-5a)
defines the proposed admitted local-helper exception. Archive acquisition is
in progress in #2101, targeting zero downloads on intact warm archive generations.
Zero archive decodes is conditional on extraction replay, parked under DQ08.
Report actual extraction/download work and bytes separately from
native action counts; a host-cache hit is not a remote command-action cache hit.
Extraction and assembly retain the local materialization policy above.

Historical archive-command evidence can contain `archive-origin-fallback`
diagnostics with reasons `not-found`, `headers-timeout`, `connection-error`,
and `server-error`, and projected `archiveOriginFallbacks` reason counts.
Those describe past command-based acquisitions, not a current runtime
fallback contract. Native downloads emit no such repository-owned diagnostics.

The summary adds `cacheOutcomeMapping: "effect-utils/compact-cache-outcome/v1"`
and `actionsArtifact: { name, rows, sha256, bytes, uncompressedBytes, complete,
droppedActionCount }`. `name` is `buck2-cache-actions.jsonl.gz`; `sha256` hashes
the compressed bytes. Valid complete evidence satisfies
`actionsArtifact.rows == actionCount`, and both full-artifact dropped counts are
zero. Existing compact consumers need not change.

The gzip payload is UTF-8 JSONL with a header followed by one action record per
first native `ActionExecution` end span. Rows are never grouped or sampled.
Missing fields remain explicit `null`; they do not suppress a row.

| Header field            | Contract                                                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`, `schemaVersion` | `"header"`, `1`                                                                                                                                             |
| `cacheOutcomeMapping`   | Repository-owned versioned mapping identifier above                                                                                                         |
| `metadata`              | `repo`, `runId`, `runAttempt`, `job`, `lane`, `headSha`, `posture`, `startedAt`, `finishedAt`; once per file                                                |
| `lane`                  | `main-writer`, `main-reader`, `merge_group`, or `pr`; unknown is `null` and cannot pass                                                                     |
| `posture`               | `read-only`, `writer`, or `disabled-by-design`                                                                                                              |
| `status`                | `collected`, `no-native-logs`, or `remote-cache-disabled-by-design`                                                                                         |
| Completeness            | `complete`, `actionCount`, `rows`, `droppedActionCount`, `missingDigestCount`, `missingIdentityCount`, `missingTimestampCount`, `evidenceGaps`              |
| `invocations`           | Native `buildId`, `context`, command `startedAt`/`completedAt`, `freshRoot`, optional sanitized `rootId`, `actionCount`, `excludedByDesign`, and `complete` |
| `excludedByDesign`      | Reason-keyed counts, including `local-materialization-policy`; independent of native outcome counts                                                         |

| Action field          | Contract                                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `type`                | `"action"`                                                                                                                                                                     |
| Identity              | `buildId`, `context`, `category`, `target`, full `configuration`, exact native AC `digest` (`hash:size`)                                                                       |
| Configured action key | Optional opaque `identifier` hash (or known empty protobuf default); with `target` (owner), `category`, and `configuration`, identifies local dep-file reuse; not an RE digest |
| Native classification | Integer `executionKind` and `cacheUploadResult`, retained even when the normalized outcome overrides the kind                                                                  |
| Outcomes              | `outcome` and `cacheOutcome` use the named compact mapping; `uploadOutcome` is `uploaded`, `failed` (native values 9–15), or `not-uploaded`                                    |
| Times                 | `startedAt`, `completedAt`, `endTime` (same as completedAt), `uploadCompletedAt`                                                                                               |
| `commandAction`       | Native action kind is `Run`; non-command actions are retained but do not form a command-cache denominator                                                                      |
| `exclusionReason`     | Repository-owned exact reason `local-materialization-policy` for the policy categories; `null` otherwise                                                                       |
| `uploadErrors`        | Optional array of `{ category, reErrorCode }`, one per failed native `CacheUpload` end; category is closed, gRPC code is 0–16 or `null`                                        |

All times are integer Unix milliseconds. The pinned log decoder emits native
timestamps as `[seconds,nanoseconds]`; conversion floors sub-millisecond time.
`uploadCompletedAt` is the successful action-end timestamp: a conservative
upper bound on completed upload, never an inferred start plus `wall_time`.
Equality with reader start is **not** prior completion. Missing command starts,
command ends, identity/digest/timestamps, unpaired action starts, unsupported
native enums, decode/discovery errors, checksum mismatches, and truncated data
invalidate an observation. Legitimate nondigest non-command actions still
contribute to omission counters, not a fabricated AC identity.

Failed uploads use the pinned `CacheUploadEnd.error` and optional
`re_error_code`, not `ReUploadEnd` (which contains transfer metrics only).
Native span ancestry associates each first upload end with its active action;
duplicate ends do not duplicate diagnostics. An unpaired failed upload
invalidates invocation completeness. All failed upload attempts remain in the
full action row, even when a later attempt succeeds. Compact representatives
carry the same optional `uploadErrors` array; they remain bounded samples, not
an exhaustive failure list. Absence means no diagnostic was collected, including
retained evidence produced before native upload diagnostics were collected.

Upload diagnostics retain only a closed category (`unauthenticated`,
`permission-denied`, `deadline`, `unavailable`, `resource-exhausted`,
`invalid-argument`, or `other`) and an optional numeric gRPC code from 0 through 16. Known native enum names and numeric codes map to those numbers; unknown
codes become `null`. Fixed patterns classify native error text, which is then
discarded entirely. No credential environment or private credential context is
needed. Other upload payloads are not projected.

Successful command actions that were not uploaded, including failed upload
attempts, retain optional `outputTinyDigests` in both full rows and compact
representatives: `{ algorithm: "buck2-tiny-digest-v1", outputs:
[{ index: 0, tinyDigest: "deadbeef" }] }`. This repository-owned algorithm
identifier denotes Buck2's **truncated** first four digest bytes (32 bits,
exactly eight lowercase hexadecimal characters), not a full content digest.
The pinned implementation is
[`cas_digest.rs:701–705`](https://github.com/facebook/buck2/blob/be6971d47dcc835b7356e1698b23039ffee4f4c2/app/buck2_common/src/cas_digest.rs#L701-L705).
All categories are eligible, including `rustc`, `deps`, `cargo_extract`,
`buildscript`, `rustc_cfg`, and `rust_interop_*`. Uploaded actions, failed
actions, non-command actions, and logs without native output information omit
the field; an explicit empty native output list remains an empty list.

Indices are contiguous, zero-based positions in the native emitted output
list, preserved without sorting or deduplication. The
[`ActionExecutionEnd` emitter](https://github.com/facebook/buck2/blob/be6971d47dcc835b7356e1698b23039ffee4f4c2/app/buck2_build_api/src/actions/calculation.rs#L466-L475)
omits outputs without a digest; these indices are not declared-output indices.
**Output paths and kinds are not included.** Compare only the same native
action digest, first checking output counts and then corresponding indices.
Different values establish a difference; equal values are probabilistic
evidence, not proof of equal full digests. No filesystem hashing, materializing,
or additional Buck invocation is needed. Old artifacts without this optional
field remain readable but provide no output determinism evidence.

For approximately 534 actions and three digest-bearing outputs each, this adds
roughly 0.1 MiB of uncompressed JSON per job (an estimate, not a measurement).
Growth is linear in emitted output count, including compact representatives;
the existing 64 MiB full action-payload ceiling still applies.

The projector emits only allowlisted labels, configuration names, native digest
strings and output tiny digests, enum numbers, times, run identity, and closed
upload diagnostic categories/codes. Host paths, environment values, commands,
output paths/payloads, host names, and raw error payloads are never copied. Invalid
identity text becomes `null` rather than a lossy replacement key. The
repository-local mapping identifier has exact case-sensitive spelling and a
version suffix; unknown versions are rejected, not silently reinterpreted.
Every nonempty native action identifier is published only as
`identifier-sha256-v1:<64 lowercase hex>`, hashing the UTF-8 domain separator
`effect-utils/buck2-action-identifier/v1` followed by NUL and the original UTF-8
identifier. Relative paths, drive-letter paths, hostnames, and environment-like
values are never emitted as identifier text. The known empty protobuf default
remains `""`; absent/unknown remains absent or `null`. The decoder rejects raw
nonempty identifiers rather than republishing historical private text.
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
symlink. Finalization uses native command timestamps to mark the unique earliest
cache-bearing invocation from that root with `freshRoot: true`; later invocation
markers remain false. That marker attests the job root's initial state: warm99
counts each identity's first occurrence across the root, including later
invocations, rather than treating the marker as a command-wide admission gate.
Tied/unknown starts, redirected roots without proof, and preexisting native state
cannot claim freshness. The two-root proof explicitly marks only the first build
after each wiped root, preserving its populate/replay labels.
Every retained invocation must satisfy the native-time enclosure
`job.startedAt <= invocation.startedAt <= invocation.completedAt <= job.finishedAt`.
Equality is valid at millisecond precision. Missing or out-of-window bounds retain
rows only as incomplete evidence and revoke freshness; filesystem mtime cannot
make an older native invocation part of the current observation.

CI posture sets Buck's native `[buck2] retained_event_logs = 120`; developer
retention remains unchanged. This is a native log-count limit, not the proof
retention mechanism. Evidence-enabled commands use the pinned Buck
`--event-log` extra sink outside the rotating log directory, with its supported
`.json-lines` encoding. A private FIFO feeds the existing allowlisted incremental
projector; its mode-0600 sink is created through the platform syscall, independent
of host command lookup. The compiled launcher pins its collector's Bun interpreter
in the Nix closure, so hermetic command paths do not disable capture.
Raw events are not retained in public artifacts. A bounded sanitized
per-build-ID shard is atomically finalized only after native command completion.
The launcher waits for collection before returning the original command status.
Crashes, truncation, missing command end, overflow, or unresolved IDs remain gaps.
An existing caller-owned extra sink, such as the aggregate task's OTEL
`.pb.zst` file, is preserved rather than replaced. Immediately after native
completion, the pinned native `log show` decoder reads that exact file into the
same private projector, before the launcher returns control to its owner.
No rotating-log discovery or `--recent` lookup participates. Missing/truncated
caller files or failed decoding remain gaps, even if a decoder emitted a complete
prefix; native command status is preserved. Raw ownership, retention, and OTEL
ingestion stay with the caller.

Automatic capture is admitted only for the canonical tracked root in the
three-line `started_at`, `recorded_root`, `fresh_root` start marker and its default
`v2` isolation. Foreign fixture roots and non-default isolations cannot silently
inherit the marker. Deliberate two-root proof commands explicitly register their
own root scopes and sinks. `run` option parsing stops before executable payload
arguments; payload flags cannot change capture ownership or the native build-ID
output. The extra event-log option is placed after the leaf command, including
nested commands such as `audit providers`, but before any executable-payload
sentinel. Unknown option arities are not guessed.

The private native build-ID registry records expected commands before launch.
The finalizer reconciles expected registrations, native `--write-build-id` UUID
files, and complete sanitized shards, including zero-action commands. A registry
row alone never proves execution. Each shard has bounded rows/bytes, checksum,
native command bounds, root scope, and completion status. Completed shards remain
authoritative after any number of native log rotations or removal of Buck logs;
missing/incomplete shards fail closed rather than promoting surviving local
state. Legacy incomplete writer artifacts cannot seed successful uploads.

The full action payload retains its 64 MiB ceiling. Sanitized shard storage is
bounded separately to 64 MiB per job, with a 32 MiB per-shard ceiling and at most
4096 expected invocations; exceeding any bound invalidates the proof.
`buck2-cache-proof-manifest.json` binds expected observations/jobs, source
artifact checksums, native invocation IDs/root scopes, shard counts/checksums,
and successful upload-before-reader references to the warm99 report. A per-job
report without historical writers/readers is explicitly incomplete, not a
passing substitute for two observations. The daily join supplies explicit
historical run/job membership from workflow jobs, retaining missing/expired
evidence as gaps rather than discovering only successful uploads. Latest retained
attempt is selected per expected job and matrix cell; a rerun of failed jobs
does not discard successful jobs' older-attempt evidence. Membership matches
run ID, base job, cell, and attempt exactly: stale evidence from a rerun cell
cannot replace a missing sibling cell. The cell is a domain-separated SHA-256
token of the existing full GitHub job display name (including matrix values);
required-check display names are never changed. Unknown historical cell
identity and ambiguous discovered display names fail closed. The sanitized
manifest preserves each expected job's attempt and cell even if its evidence
reference is unavailable.

Finalization exits `2` when it successfully writes incomplete evidence, and
`1` on an operational failure. Collection preserves either failure but adds
`evidence-finalization-failed` only for an operational finalization failure,
not as a duplicate diagnosis of an already recorded evidence gap.

Jobs explicitly declared proof-disabled because they execute no checkout-native
Buck (including source-shape and in-Nix product jobs) emit no native-proof start,
collection, or upload steps and never enter the expected native cohort.
Their Nix reuse metric, where applicable, is substitution, not Buck AC.
Retained historical in-Nix headers remain disabled-by-design with zero actions.
The daily cache-health mission and post-merge proof consume the full contract.
See [observability](../07-observability/spec.md#ci-action-cache-evidence) for
the legacy compact outcome classes and missing-evidence counters.

### Per-lane warm99 evaluation

```text
trusted writer per-action observation < fresh reader invocation start
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
jobs, and each expected job needs a complete fresh-root attestation. Only complete
`main-writer` artifacts with writer posture establish trusted presence: either a
successful upload at `uploadCompletedAt` or a verified native execution-kind `3`
remote hit at that action's `completedAt`. Each exact observation must precede
the invocation containing the reader's first occurrence strictly; equality and
future timestamps do not bind. There is no cohort-wide timestamp cutoff.
PR and merge-group artifacts never bind, even with writer posture or uploads;
intentionally ineligible writer references are not missing-evidence errors.
A raw reader remote hit without such a trusted anchor remains cold.
Historical proof manifests expose these per-invocation bindings as
`writerPriorObservationBindings`, with `priorObservationCount` and an exact-identity
hash per contributing writer reference.
An identity is `(category,target,configuration,digest)`. Its first
occurrence in each root counts, in any invocation; every repetition in the same
root is excluded-nonfresh. All eligible first occurrences across distinct reader
roots must have raw execution kind `3` to count as a remote hit. Local-action-cache,
local-cache and local-dep-file outcomes are misses or excluded repetitions,
never remote hits, even if the compact mapping calls them cache hits.
Writer and reader repository metadata must agree. Distinct observations require
distinct native reader build IDs; replaying one artifact under a new manifest
sequence is an evidence gap, not a second fresh-root measurement.

Native invocation evidence records `cacheReadPolicy` as `enabled`,
`disabled-by-design`, or `unknown`. Collection accepts `--cache-read-policy`;
the capability-identity proof explicitly declares only its `dependency` phase
disabled, matching `--no-remote-cache --config buck2.remote_cache_enabled=false`.
Its baseline/selected/unused/action-env phases remain cache-enabled, including
the same dependency action categories. A deliberately disabled invocation does
not attempt an ActionCache lookup: its rows count as excluded, never eligible,
cold, avoidable/local reader misses, or trusted presence anchors. It does not
consume an identity's later cache-enabled first occurrence in the same root.
Native outcomes and category policy counts remain unchanged.

Retained evidence without the new field remains authoritative. The decoder's
reader arm recognizes the reserved `capability-identity-dependency` context
protocol as disabled, independently of run or revision. The context's
[evidence-producing introduction](https://github.com/overengineeringstudio/effect-utils/blob/7bda6fe68793924bd37bea44a3535237d6912e79/scripts/buck2-capability-identity-proof.sh)
already required `--no-remote-cache` and `buck2.remote_cache_enabled=false`;
the [original dependency control](https://github.com/overengineeringstudio/effect-utils/blob/6e05e3dc23f52dda3323c8d79653c3595fc48dbc/scripts/buck2-capability-identity-proof.sh)
also disabled reads, before its native rows were collected.
Inspected reader sources
[`d749e890d67386a5f23d9787444bfcb3e491f4da`](https://github.com/overengineeringstudio/effect-utils/blob/d749e890d67386a5f23d9787444bfcb3e491f4da/scripts/buck2-capability-identity-proof.sh#L106-L115)
and
[`110fa22c52d387f440494118adfe2013bb5dacfa`](https://github.com/overengineeringstudio/effect-utils/blob/110fa22c52d387f440494118adfe2013bb5dacfa/scripts/buck2-capability-identity-proof.sh#L106-L115)
preserve that protocol. These are evidence citations, not a head-SHA whitelist.
This is source-contract classification, not a retroactive producer attestation;
proof invocation projections expose the classified policy with source metadata
and original artifact checksums. Every other missing-policy case stays
`unknown`, preserving the existing lane/posture scoring behavior rather than
inventing a disabled lookup or invalidating all retained writer anchors.
Local execution alone never proves reads were disabled.
An explicit policy field takes precedence. Remove the retained reader arm only
after an admitted-artifact inventory reports zero invocations without
`cacheReadPolicy`; its no-retained-input behavior is covered by decoder tests.

Freshness belongs to an identity's first occurrence in an attested fresh job
root, not to the first cache-bearing invocation alone. Each root represented by
a reader artifact must attest that it began without prior native state.
Sanitized invocation `rootId` is an opaque 64-character lowercase hexadecimal
scope for explicit multi-root proofs; it contains no host path. A retained
single-root artifact without `rootId` has one legacy scope.
All eligible, cold, changed, and noncacheable counting keys retain both reader
artifact and root scope. Distinct fresh roots, including the same checkout path
in separate jobs, do not deduplicate each other's identities: 100 eligible
identities per root with two misses in one root yield 198/200, not 98/100.
Multiple fresh roots without unambiguous scope are an evidence gap. Command rows
are ordered by their native start timestamps before deduplication. Zero-action
audits do not consume freshness. In particular, a new
identity in a later invocation counts normally even if its inputs came from
local execution in an earlier invocation of the same root. This measures each
action's first cache lookup without hiding later commands behind bootstrap work;
it does not require every input producer to have been a remote hit.

Every new command identity requires its native digest, including later
invocations. A missing digest is an evidence gap, not a basis for guessing
identity. Uploaded rows always require their native digest.

The sole digestless repetition exception is native `LocalActionCache` (execution
kind `10`, local dep-file reuse). Pinned Buck returns
[`ActionExecutionMetadata::LocalActionCache` from `dep_files.rs:941–982`](https://github.com/facebook/buck2/blob/be6971d47dcc835b7356e1698b23039ffee4f4c2/app/buck2_action_impl/src/actions/impls/run/dep_files.rs#L941-L982)
and [`run.rs:1147–1160`](https://github.com/facebook/buck2/blob/be6971d47dcc835b7356e1698b23039ffee4f4c2/app/buck2_action_impl/src/actions/impls/run.rs#L1147-L1160)
returns before preparing the command and its RE action digest. Therefore a
kind-10 row is excluded-nonfresh only when the same attested root has an earlier
digest-bearing command occurrence with the same configured action key
`(owner,category,identifier,configuration)`, completed no later than the local
reuse started. Millisecond equality is valid. An unavailable native identifier,
a different root, or no such earlier occurrence is an evidence gap. The configured
key proves a repetition, never an inferred RE digest: kind `10` is neither a
new identity nor a remote hit.
The codec's `classifyCacheAction` identifies kind `10` as a local-action-cache
hit, never an avoidable local-execution candidate. Such candidates are only
non-policy-excluded command actions of kind `1` or `8` with a native digest in
a matched fresh invocation (`fresh-local-execution`); every other outcome is
outside that set. Policy exclusion does not relabel a kind `10` cache hit.
Missing identity fields or timestamps remain evidence gaps. Cargo and
default-ref-policy jobs execute no native Buck actions and are explicitly
disabled-by-design, not remote-cache reader or writer lanes.

The report separates cold tuples (no prior trusted observation), changed tuples
(same category/target/configuration, different previously observed trusted digest), excluded
nonfresh/disabled actions, reason-keyed `excludedByDesign` policy counts,
noncacheable native actions, upload failures, and evidence gaps. Policy rows
cannot seed the trusted-presence cohort or enter the eligible denominator, including
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
descriptor files, and zero executed/local-cache **cache-eligible** build actions
on B. It uses the shared local-materialization classification to exempt cheap
tree/store assembly without dropping those actions from retained evidence.
`scripts/buck2-remote-cache-proof.sh --assert-context-b-build <native-log.jsonl>`
replays the same build assertions without contacting the cache or mutating proof
sources. Its integration suite gives each replay its own test case and awaits
the subprocess exit and output streams. The runner's normal timeout guards
hangs; replay latency is not a production deadline, and a case matrix does not
share a single wall-clock budget. Replays run in isolated process groups;
timeout cleanup kills the group and waits for all descendants to be reaped
before deleting the event-log fixture. A two-second reaping hang guard fails
cleanup with process-group diagnostics and preserves fixtures if the group
does not disappear.

### Lane budget measurements

Record edit-run, quick check, full tests and platform/host proof separately. For
each lane record platform, revision, target closure, cache posture, warm no-op,
fresh-context warm-cache time and host load. No 5-second/3-minute universal budget
is substituted for a measured lane budget (axe record `uttvbj`).

### Cache efficiency measurement

BUILD.BUCK.REUSE-R08–R14 retain their rolling 7-day evidence window. The legacy
compact observed rate counts native outcome spans:
remote hit / (remote hit + local execution + local cache + upload).
The warm99 acceptance gate uses the distinct exact-identity, trusted-presence,
fresh-root denominator specified above, not that observed aggregate.

| Requirement | Evidence                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| R08–R10     | Full CI action-identity artifacts and warm99 reports; R08 joins local executions against prior trusted public-tier observations |
| R11         | public tier server request counters (`GetActionResult` hits/misses, `UpdateActionResult` writes)                                |
| R12         | weekly two-root probe per trusted host, native event log                                                                        |
| R13         | narinfo presence for each published product and the publish-run derivation diff                                                 |
| R14         | daily cache-health measurement history                                                                                          |

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
