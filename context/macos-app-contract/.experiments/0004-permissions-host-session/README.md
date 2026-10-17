# Permissions host: human-present consent session

This directory is an executable experiment, **not evidence that the experiment passed**.
No protected call, build, signing operation, installation, grant or reset is performed by
preparing these sources. Run only against the disposable
`dev.overeng.permissions-host.experiment` host. Never grant the client or a production app.
The native fixture is `dev.overeng.permissions-host.fixture`.

## Entrypoints and prerequisites

- `sh prep.sh "$CONFIG"`: validate private configuration and client existence only.
  It never starts the GUI watcher, log stream, host or any protected operation.
- `sh live.sh "$CONFIG"`: arm both tripwires, then accept one operation per line.
- `sh revocation.sh "$CONFIG"`: arm both tripwires and require denied protected results.
  Use a **new** evidence directory for each invocation; existing directories are refused.
- `python3 evidence.py RAW_JSONL`: offline AUTHREQ extraction, including `authValue`.
- `session.py watch-gui DIRECTORY`: internal launchd entrypoint; not a prep command.

The harness requires macOS, standard-library Python 3 available to a directly launched
GUI agent, `/usr/bin/log`, `/bin/launchctl`, a logged-in unlocked console session, an
already built native CLI, and a readable host JSONL audit. It neither installs packages
nor builds/signs anything. Native source/build instructions live in `native/`:
`bash native/build.sh "$OUT_V1" 1` and `bash native/build.sh "$OUT_V2" 2`.
The builder needs Xcode command-line tools, an arm64 macOS builder and the macOS 14.4+
SDK. Each output contains `probe-host`, `client`, and `PermissionsFixture.app`; these
commands compile sources only and do not launch protected probes. Root `default.nix` accepts
`pkgs`, `nixpkgsRevision`, `nativeBundle`, `release`, `signer` and optionally `allowedUid`;
its outputs are `hostApp`, `ctl`, `ctlConfig`, `generation`, `desiredDescriptor`, `bundle`.
Pinned restic is a bundle dependency, not an executable resolved from PATH. Watchman is
optional (`includeWatchman`, default `false`) and excluded from this session's v1/v2 bundles:
the pinned package has external Nix-store dylibs, which ctl correctly rejects.
A worker-byte-changed release requires a separately assembled/resealed bundle, not a
post-signature helper replacement. Pre-sign `helpers.json` hashes are provenance only;
signed resource validation and the pinned designated requirement govern installed code.

On the authorized idle builder, assemble each native app using the store-first harness:

```sh
bash assemble.sh "$OUT_V1/MacPermissionsHostExperiment.app" 1 "$SIGNER_JSON" "$ASSEMBLED_V1"
bash assemble.sh "$OUT_V2/MacPermissionsHostExperiment.app" 2 "$SIGNER_JSON" "$ASSEMBLED_V2"
```

`SIGNER_JSON` contains only the privately supplied public identity policy (`teamId` and
`identity`), never a password. The harness first runs
`nix store add --mode nar "$NATIVE_APP"` and then passes the returned store path as
`nativeBundle`; this import is mandatory because build users cannot read home directories.
`assemble.nix` wraps that string with `builtins.storePath` to declare it as a sandbox
input; a context-free `--argstr` alone is insufficient. The harness uses `--impure`
evaluation for this operation.
Do not substitute `toString` or a home-directory path. `default.nix` rejects non-store
inputs. Assembly exposes `hostApp`, `ctl`, `ctl-config.json`, `desired-descriptor.json`
and `generation` under the output link. This is unsigned assembly, not install or seal.
Inspect every native file with `otool -L`; store dylibs must be bundled/relocated before
ctl can accept them. Never weaken ctl's non-bundled-native-path guard.

Sources may be copied to an isolated builder and unsigned builds prepared there.
**No prep sealing, artifact transfer to the runtime machine, or runtime installation.** A signer
and sealed, verified v1/v2 artifacts are mandatory before the live harness starts.
Sealing occurs at step 0 with the human present, on the authorized signer machine.
The configuration acknowledgement is not a substitute for actual ctl verification.

Keep configuration and raw evidence outside version control. Required private JSON keys:

| Key | Value supplied by the operator |
| --- | --- |
| `authorizedHost` | Exact authorized runtime machine hostname; never commit it |
| `client` | Absolute built native client executable path |
| `socket` | Host Unix socket path, as configured for the installed GUI job |
| `hostAudit` | Exact native host JSONL audit path |
| `evidenceDirectory` | New private directory for this invocation |
| `sealedReleasesVerified` | Boolean `true` only after sealed v1/v2 verification |
| `sshJump`, `sshTarget`, `remoteClient` | Optional real SSH jump, runtime target and remote client path; required for `ssh OP` |

No private hostname, account name, home path or personal identity belongs in committed
config or evidence. The SSH hop uses BatchMode and strict known-host checking; establish
connectivity outside the experiment, never accept a surprise authentication prompt.
The old `run-local.sh`/`run-ssh.sh` files were not present in this checkout. This harness
reuses their documented tccd predicate and SSH-hop topology and `../safety.py`'s CI
exclusion/explicit-host-pin/no-arbitrary-signing principles. It does not call that
headless runner's window API: SSH has no reliable GUI window list.

### Guard contract

All operations use native `client ask --socket PATH --request '{"op":"…"}'`.
Only `automation.a.request`, `automation.b.request`, and `microphone.request` may carry
`--allow-prompt`. Each prompt is announced aloud/in the console and requires a separate
`ALLOW OP` acknowledgement. The live-session waiver applies to those exact operations
only, never to prep, revocation or unattended use.

Before every non-status command the harness obtains a fresh `status` permission map;
the native host independently performs a silent preflight immediately before **each**
protected API call. The harness authorizes non-preflight tccd activity only for observed
granted services during that operation, or the one announced prompt service. Automation
uses the grant for the selected target, not the other target's allowance. Missing or
unrecognized correlation/preflight data aborts. `AUTHREQ_*` JSON records are correlated
by `msgID`; CTX, SUBJECT, ATTRIBUTION and RESULT are preserved, not collapsed into an
invented verdict. Global unrelated unannounced AUTHREQ activity can also abort: this is
intentionally conservative. Close unrelated apps before starting.

A directly launched `gui/<uid>` Python watcher polls CoreGraphics window owners. Any
visible `SecurityAgent` or `UserNotificationCenter` window aborts, **even during an
announced prompt**; do not dismiss it automatically. Those owners are never waived.
An unavailable window list, dead watcher, stale heartbeat, dead/malformed tccd stream,
unknown AUTHREQ kind, ambiguous audit correlation, or request timeout aborts. Polling is
a tripwire, not a proof that an arbitrarily brief window never existed. The host's silent
preflights and explicit prompt flag remain the preventive boundary. Abort kills the
in-flight client process group and removes the experiment watcher; it does not kill the
host, click dialogs, reset TCC, or claim cancellation of an already executing host call.
Stop all further commands and let the human inspect any visible dialog.

## Numbered human-present script

Run the following in order. The harness console accepts an allowlisted native op,
`ssh OP`, `prompt OP --allow-prompt`, `note TEXT`, or `quit`. Keep the fixture test-pattern
window visible for window-only ScreenCaptureKit capture. Never capture unrelated content.

0. **Human present: seal and verify first.** On the authorized signer, use the actual
   built `ctl` and matching configuration to run `describe-host` for v1/v2, then
   `prove-signing-key --no-sign`, then `seal-host` with the dedicated keychain and password
   file descriptor. With operator-supplied shell variables and a fresh password pipe/file
   descriptor for **each** credential-using invocation, the exact source-defined commands are:

   ```sh
   "$CTL" describe-host --config "$CTL_CONFIG_V1" --desired "$UNSIGNED_APP_V1" > "$DESCRIPTOR_V1"
   "$CTL" describe-host --config "$CTL_CONFIG_V2" --desired "$UNSIGNED_APP_V2" > "$DESCRIPTOR_V2"
   "$CTL" prove-signing-key --config "$CTL_CONFIG_V1" --keychain "$KEYCHAIN" \
     --keychain-password-fd "$PASSWORD_FD" --no-sign
   # Re-open/replenish PASSWORD_FD through the approved credential source before each seal.
   "$CTL" seal-host --config "$CTL_CONFIG_V1" --desired "$UNSIGNED_APP_V1" \
     --output "$ARTIFACT_V1" --keychain "$KEYCHAIN" --keychain-password-fd "$PASSWORD_FD"
   "$CTL" seal-host --config "$CTL_CONFIG_V2" --desired "$UNSIGNED_APP_V2" \
     --output "$ARTIFACT_V2" --keychain "$KEYCHAIN" --keychain-password-fd "$PASSWORD_FD"
   ```

   Paths, identity policy and password descriptors are supplied privately, not copied
   literally from this document. Each release uses its matching ctl configuration;
   the keychain must be the authorized dedicated per-user signing keychain.
   Never pass a password on argv or touch an unrelated login keychain. If signer access fails,
   stop: unsigned builds are not an acceptable substitute. Transfer the sealed artifacts
   to the authorized runtime machine only now. Install v1 with `install-host --artifact`,
   run `verify`, and record its DR, sealed revision and fixed installation path privately.
   Launchd must execute the native host directly in the GUI domain, not through a wrapper.
   Verify the host audit/socket ownership and client identity before opening the harness.
   If manual Settings authentication later creates a forbidden window owner, the harness
   must abort even though the human initiated Settings. Finish only the explicitly
   authorized Settings action manually, inspect the dialog, then re-arm in a new evidence
   directory and repeat fresh preflights before proceeding. Never suppress the tripwire.
1. Human manually opens `PermissionsFixture.app`, TextEdit and Calculator in the console
   session, confirms all three are running, and leaves the fixture test pattern visible.
   Do this before any Automation preflight or request; the harness does not launch targets.
   Start `live.sh` with a fresh evidence directory. Confirm `armed` and both tripwires;
   run `status`, both Automation preflights, `microphone.preflight`, `fda.preflight`.
   Record actual returned states and numeric OSStatus values. `procNotFound` (`-600`)
   is a missing/unreachable target, **not** consent-required (`-1744`); repair target
   availability and repeat the silent preflight rather than classifying it as denial.
   No denial is a license to try a protected API.
2. In System Settings → Privacy & Security → Full Disk Access, add the disposable host
   using `+`, authorize manually, and tick it. Run `fda.preflight`; only now `private.seed`.
   Do not open Documents to test denial: FDA itself is the non-prompting gate.
3. In Screen & System Audio Recording, add the host with `+`; choose Later if offered
   Quit & Reopen. Restart the host's actual GUI job using its configured label via
   `launchctl kickstart -k gui/<uid>/<label>`; never substitute a shell wrapper. Record
   whether restart was needed. Run `screen.capture` and inspect returned frame hash,
   dimensions and test-pattern evidence. Run `ssh screen.capture` too.
4. In Accessibility, add/tick the host with `+`. Run `ax.probe`, then `ssh ax.probe`.
   Observe and note the fixture title and counter change. The client receives no grant.
5. Run `audio.capture`: synthetic output and system-audio capture must demonstrate the
   expected 1 kHz peak. This does not prove microphone or process-tap authorization.
6. Run `notifications.provisional` (silent provisional only). In Settings → Notifications,
   select the host and choose Banners. Run `core.notify`; record a human yes/no for host
   name, icon and product-prefixed title using `note …`. Submission alone is not display.
7. **Announce Automation target A:** “The disposable host will now ask to control TextEdit.”
   Type `prompt automation.a.request --allow-prompt`; acknowledge `ALLOW automation.a.request`
   only while present, then answer that specific dialog. Run both Automation preflights:
   A's allowance must not pre-approve Calculator. Record target bundle IDs and results.
8. **Announce Automation target B separately:** “The disposable host will now ask to control
   Calculator.” Type `prompt automation.b.request --allow-prompt`; acknowledge exactly
   `ALLOW automation.b.request`. Answer only that dialog, then recheck both preflights.
9. **Announce microphone separately:** “The disposable host will now ask for microphone
   access for this live test.” Type `prompt microphone.request --allow-prompt`; acknowledge
   `ALLOW microphone.request`. Answer that dialog and record actual capture/status evidence.
   Do not run prompt commands unattended or infer process-tap support from this result.
10. Run `private.experiment-restic-backup`; inspect the real check/dump/hash evidence and
    tccd host attribution. No client argv is forwarded to helpers.
11. Record DQ7 W1 and W2 as **deferred: Watchman needs a self-contained bundled build
    (dylib relocation) before it can live inside the host**. Do not execute Watchman
    operations or install a root daemon in this session.
12. Human locks the screen. Try `ax.probe` and `screen.capture` without requesting anything;
    record success or `session-unavailable` honestly. If GUI enumeration becomes unavailable,
    the harness aborts; unlock and restart with a fresh directory rather than disabling it.
13. With existing grants, use ctl's journaled upgrade path: v1 → v2 → rollback v1, verifying
    each installed release and rerunning screen, AX, notification, FDA and pinned restic
    probes plus fresh local/SSH clients. To test changed helper bytes, additionally install
    the separately resealed worker-byte release and repeat; never relabel v2 as that case.
    Do not rebuild, sign or replace binaries within a running probe. Record actual inode,
    DR, version, digest and release receipt evidence; return to v1 afterward.
14. Human returns. Untick Screen Recording, Accessibility and FDA; disable Allow
    Notifications. Quit the current harness, choose a new evidence directory, run
    `revocation.sh`. Every tested capability must return `permission-required` without a
    protected call. Revoke Automation per target and microphone in Settings too; a fresh
    live invocation's preflights must show those denials without new prompt flags.
15. Remove the Screen Recording/AX/FDA entries with `−` where supported. Notification
    registration may remain disabled. Stop the host through ctl's normal uninstall or
    its GUI job bootout. Remove only disposable fixture/staging/restic/watch directories,
    socket, releases and generated watcher files owned by this experiment. Never run
    a broad TCC reset. Record cleanup and retained Settings entries explicitly.

### DQ7 Watchman (W1 and W2 deferred)

**Deferred: Watchman needs a self-contained bundled build (dylib relocation) before it
can live inside the host.** The pinned executable links external Nix-store Boost and
other dylibs. It is excluded from both session bundles and the live/revocation operation
allowlists. Neither W1 nor W2 is executed or treated as passing in this session.

The optional bundle setting is only usable after a self-contained package is provided
and every dependency passes ctl's existing guard. This does not authorize a root daemon,
`AssociatedBundleIdentifiers` changes or arbitrary execution, and ctl is not weakened.


## Pass/fail decision table

Every row starts **unrun**, not pass. Review actual client response ↔ host `auditId` and
peer UID/GID/PID ↔ tccd subject/result ↔ output bytes, then record pass/fail/unresolved
with evidence references. A missing log line can be caching; it is not `authValue=2`.

| DQ | Required pass evidence | Fail / unresolved condition |
| --- | --- | --- |
| 1 upgrade/rollback | Same DR/path/topology, verified v1→v2→v1, rebuilt ungranted local/SSH clients and positive capabilities throughout; changed-worker release separately identified | New prompt/denial, identity drift, absent release/rollback proof; worker-byte case unrun if no third release |
| 2 screen | Host subject with allowed result, nonempty fixture-only image and expected-pattern hash validation, local and SSH peer audit | Client/sshd subject, empty/wrong image, missing pattern validation or prompt |
| 3 AX | Host attribution, real fixture AXTitle and counter change; locked-session result recorded separately | Client grant needed, wrong target, no changed counter; lock outcome omitted |
| 4 audio | Real 1 kHz captured peak, separate microphone status and explicit announced positive mic test | No captured signal, extra prompt, conflating output/system/mic/process tap; process tap remains unresolved unless independently tested |
| 5 notifications | Settings state + notificationId + human confirmation of host name/icon/title; disabled denial | Merely submitted, wrong sender/prefix, prompt, absent human observation |
| 6 Automation | Distinct TextEdit/Calculator preflights, A does not grant B, separately announced authorized request/results per target | Cross-target preapproval, unannounced request, missing positive result/attribution |
| 7 Watchman W1 and W2 | **Deferred: Watchman needs a self-contained bundled build (dylib relocation) before it can live inside the host** | Not executed in this session; neither W1 nor W2 may be reported as passing |
| 8 pinned restic | Fixed argv, pinned signed nested helper, host FDA subject, successful real check/dump and all seeded hashes; resealed changed-worker run | Worker subject, mismatch, only sentinel, unsigned helper mutation, missing changed-worker case |
| 9 Documents→import | **Deferred to the host build step (Q19 step 4), in the real private host repository** | Not executed in this session; never report this session as an import pass |

### DQ9 external integration precondition

No consumer inbox/import implementation exists in this public experiment. The real host
build step must obtain from the consumer owner its actual inbox path, import argv/API,
disposable destination, receipt semantics and cleanup contract. Configuration must be
explicit and fail closed when missing; do not invent a consumer, a fake receipt or an
integration command. That step must correlate native copy `auditId`, all three staging
file hashes, inbox bytes, actual successful import receipt and destination contents.
A sentinel-only success or copied files without an import is not sufficient. The native
copy operation may exist, but this harness deliberately does not execute it for DQ9.

## Evidence and handoff

Each live invocation writes private raw/parsed tccd JSONL, client responses, correlated
host audit rows, human notes and session armed/abort records. The GUI heartbeat is liveness,
not result evidence. Retain ctl release/install/verify/rollback receipts, fixture image
and audio results, restic dump comparisons, notification observations,
OS/build and cleanup separately with references. Do not create an empty `evidence.json`
and call it a run. Publish only sanitized actual observations; never commit raw logs,
plist absolute paths, peer account details, sensitive screenshots or arbitrary app names.

Audit correlation requires exactly one `begin` row followed by exactly one `complete`
row for the response's `auditId`; both rows are retained. Missing, duplicate, reversed
or unknown phases abort rather than treating an intent as a completed operation.
The pure regression suite runs without any platform permission calls:
`PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s . -p 'test_evidence.py'`
from this directory.

Preparation checks: the pure audit regression suite passed all four tests. `otool -L`
on both existing release hosts, clients and fixtures found only system framework/runtime
paths; both existing bundled restic copies link only `/usr/lib/libSystem.B.dylib`.
The excluded Watchman executable links external Nix-store dylibs. These are dependency
inspection results, not permission or attribution results. Existing bundles containing
Watchman are not session candidates; reassemble with the default exclusion.

The store-first assembly harness and revised worker inventory have not been built here.
The integration owner must assemble candidates and exercise malformed/unrecognized
AUTHREQ handling, GUI watcher bootstrap/loss, announced prompt scope, revocation denial
and native audit correlation on the authorized machine. No signing or protected runtime
checks were executed.
