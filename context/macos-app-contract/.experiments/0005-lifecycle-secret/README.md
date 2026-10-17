# E5 — inherited lifecycle lock and secret descriptor falsifier

Publication note: host labels, user-specific paths, temporary-directory roots
and keychain paths in this directory were mechanically replaced with generic
placeholders (`headless CI Mac`/`headless-ci-mac`, `interactive Mac`/
`interactive-mac`, `<worktree>`, `<keychain>`, `<temporary-directory>`), and
retained receipt filenames were renamed to match. Numeric values, hashes, exit
codes and observed results are unmodified.

## Final remote verdict: PASS

On the headless CI Mac the corrected native suite exited 0 with **72 assertions**; stderr
was empty. Every pre-build/pre-run CI check recorded zero active jobs; audit
flags were `0x5020`, with window list explicitly unavailable. All eight secret
cases restored fd census 3 → 3, and the whole suite restored its initial census.
The native lock/cancellation cases passed; temporary lock directory and compiled
build tree were removed. `evidence.json` is the complete observed receipt.

The PASS is for the corrected full-capacity receiver and native lifecycle
fixture. The small ancillary-buffer design remains falsified, and merged ctl's
lifecycle-fd interface remains absent. No real installation, repair or
generation change was performed.

The initial remote attempt stopped before compilation because CGWindowList was
unavailable; `2026-10-14-headless-ci-mac-window-gate.json` retains that refusal. The
Manager then accepted the merged ctl integration's `no_ui_session` helper
(#1834). The same helper is reused verbatim: `getaudit_addr` must succeed with
GRAPHIC `0x10` and CONSOLE `0x2000` absent before every step and throughout
monitoring. NULL CGWindowList remains recorded as **unavailable**, not zero.
Any failed audit read or UI-capable transition fails closed.

## Authorized remote continuation

The Manager authorized completion on **the headless CI Mac over SSH only**, with no CI
job running before each step and every build/run at `nice -n 19`. The shared
`../safety.py` gates Runner.Worker/CI job processes and monitors CGWindowList,
stopping on any new visible window without touching it. There is no signing,
keychain, launchd or TCC operation. Run shape:

```sh
ssh headless-ci-mac 'nice -n 19 python3 REMOTE/0005-lifecycle-secret/run.py'
```

The receiver now bounds every ancillary header and fd read to the actual
received control buffer, even when a truncated Darwin header retains a larger
original `cmsg_len`. Bytes outside that buffer must never be treated as fd
integers. `evidence.json` records this remote run; the earlier local failure is
retained separately as `2026-10-14-interactive-mac-aborted.json`.

The bounded-parser-only remote run still failed its last fd census; retained
`2026-10-14-headless-ci-mac-small-buffer-failure.json` is a real falsifier of the
two-fd-buffer design. Darwin installs every right before copying/truncating
ancillary data; undisclosed descriptors remain open in the receiving process.
Reading beyond the buffer is not a cleanup solution.

The corrected receiver allocates a bounded control buffer for all possible
Darwin rights, then accepts exactly one and closes every extra. XNU declares
`UIPC_MAX_CMSG_FD = 512`; sender control is also bounded by `MCLBYTES`. Sources:
[unp_externalize](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/uipc_usrreq.c)
and [copyout_control/sockargs](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/uipc_syscalls.c).
Any design assuming a tiny rejected ancillary buffer automatically closes
undisclosed Darwin rights is **FAIL** and must change. The final fixture tests
the identical eight-fd adversary with complete receive capacity, plus payload
truncation; it does not relabel the earlier small-buffer truncation as safe.

Native macOS C fixture only. `probe.c` is not a production implementation or a merged-ctl wrapper. The current authorization is the headless CI Mac only, CI-idle, nice 19. No launchd loads, signer, login keychain, TCC access, sudo, or production changes.

## Historical interactive Mac status: FAIL, then Manager stop

One sequential `nice -n 10` clang build succeeded with no diagnostics. One
native suite run exited **1**. `2026-10-14-interactive-mac-aborted.json` contains the
complete captured output: inherited-lock/helper-death exclusion and all three
protected-action events passed, as did valid/missing/extra/socket/writable/
malformed-marker descriptor cases and their measured fd census checks. Output
stopped before the truncated-ancillary case completed; stderr was empty. The
whole suite therefore **did not pass**. No inference of truncation safety or
overall leak freedom is warranted.

Merged ctl actually returned exit 64 and JSON `invalid-input` with reason
`Unknown option --lifecycle-fd`; no keychain command or launchd load was used.
The build executable tree was removed. The Manager then stopped **all**
experiments on the interactive Mac for the night; no further build, run or diagnostic
experiment was attempted. The failed truncation case must be diagnosed in a
later approved window before using this fixture as design evidence.

This incomplete fixture run does not establish a kernel primitive or THIN
design failure. It leaves the complete malformed-descriptor falsifier unmet.
The source and methodology below describe intended acceptance, not observed
success.

## Command interface

The remote runner wraps these native steps with CI exclusion and a UI tripwire:

```sh
nice -n 19 clang -std=c11 -Wall -Wextra -O2 probe.c -o TEMP/probe
nice -n 19 TEMP/probe suite
```

No extra frameworks or libraries are required on macOS; the descriptor census uses Darwin `proc_pidinfo` from libSystem. The build uses one compiler job (within the maximum of two jobs). The parent owns removal of its compiled executable; the suite removes its own private `/tmp/m3-e5-XXXXXX` directory and lock file. It exits 0 only after all assertions pass, 1 on a failed assertion, and 124 on the 30-second suite watchdog. Synchronization reads also have three-second bounds. A failure kills/reaps tracked fixture children and removes temporary files. Forced SIGKILL of the suite itself cannot run cleanup.

Fixture command entrypoints, exercised through actual fork/exec by `suite`:

```text
probe install-host --lifecycle-fd FD --lock-path PATH
probe select-generation --lifecycle-fd FD --lock-path PATH
probe hold --lifecycle-fd FD --lock-path PATH --ready-fd FD
```

`FD` must already be inherited into that process; spelling an integer in a shell command does not transfer a descriptor. The two action commands validate that the descriptor references the named regular lock file and request nonblocking exclusive `flock`. They return 0 for admission, 73 for exclusion, 64 for invalid descriptor/arguments, and 74 for other lock errors. They intentionally perform no real install or generation switch. `hold` acknowledges inherited-fd admission and waits for the suite to kill it. The suite invokes itself by absolute executable path.

## Assertions and actual evidence

The suite prints individually named `PASS` assertions, numeric `EVIDENCE` descriptor counts and acceptance decisions for each secret case, and a final `PASS E5 fixture ... merged_ctl_exercised=false`. Any criterion violation is a nonzero exit rather than an informational warning. There are no pre-recorded expected results and this source has not been built or run by its authoring worker.

### Lifecycle lock

- Parent opens the private lock file and obtains an exclusive lock.
- Exec'd helper validates its inherited lock fd and acknowledges readiness. The parent SIGKILLs it and verifies the actual wait status.
- Both `install-host --lifecycle-fd` and `select-generation --lifecycle-fd` admit the parent's inherited open-file description after helper death.
- Independent competitors close the inherited owner fd, reopen the same inode, exec those same fixture commands, and must return exclusion (73). Reopening is essential: an inherited descriptor is the same lock owner, not an independent competitor.
- Only after the parent closes its final owning fd must both commands admit independently opened descriptors. No `LOCK_UN` is issued, because explicitly unlocking the shared open-file description would defeat the ownership experiment.

### Protected action

Three separate cases exercise SIGTERM, an actual 80 ms monotonic deadline, and actual client socket EOF. Readiness and event acknowledgments—not sleeps—order the cancellation and competing commands. For the deadline case, bounded polling measures expiration; elapsed time is the stimulus, not a readiness assumption.

The protected worker installs a SIGTERM handler before acknowledging readiness. It observes the relevant event, reports that event, and stays alive in the critical section until a separate commit gate is released. Both independent action commands must remain excluded during that interval. The worker then writes a `committed` marker to the locked fixture file, `fsync`s it, acknowledges completion, and exits normally. The parent checks the actual persisted bytes after worker exit, confirms its own fd still excludes a competitor, closes that fd, and verifies admission. This distinguishes surviving an event from merely suppressing an exit status. The separate commit gate is fixture instrumentation, not a proposed production protocol.

This proves the fixture's deferred-cancellation policy and kernel lock lifetime. It does not prove crash consistency of an installer, cancellation policy in merged ctl, or survival of SIGKILL of the protected worker. The helper-death test specifically proves continued parent ownership, not continued execution of a killed helper.

### Synthetic secret transport

An in-memory synthetic binary payload is written to a pipe; its read end is passed over a local Unix socket using `SCM_RIGHTS`. Payload bytes are never placed in argv or descriptor-control messages. The ancillary message carries descriptors and a one-byte type marker only. There is no file-backed secret.

The receiver must accept exactly one read-only FIFO descriptor with the exact synthetic payload, reject every invalid case, and close every delivered descriptor on both acceptance and rejection:

1. One valid pipe read fd: accept and compare actual secret bytes.
2. Missing fd: reject.
3. Two fds: reject and close both.
4. Socket fd in place of secret pipe: reject.
5. Writable pipe fd: reject.
6. Wrong protocol marker with an otherwise valid fd: reject.
7. Eight sent fds: reject and close all eight. Receive capacity is the bounded
   Darwin maximum (512 rights), not the permitted protocol count (one).
8. A nine-byte malformed payload with one fd: reject MSG_TRUNC and close its fd.
   This tests payload truncation without losing ancillary descriptor numbers.

The receiver writes its actual redacted log line and fixture ctl JSON to a pipe. The suite scans those captured bytes for the synthetic payload. It separately scans actual suite argv. Reports contain only acceptance and fd-count metadata, never secret content. This is a fixture JSON/report boundary, not evidence about merged ctl logging. The binary payload is deliberately not an authentication credential and no external secret is accessed.

Darwin `PROC_PIDLISTFDS` counts open process descriptors immediately before and after each receive, before and after each whole secret case, and across the complete suite. Equal measured counts are required. The fixed census buffer rejects a full/incomplete result rather than claiming no leak from a partial enumeration. Cleanup closes transport/report channels and sender copies too. The final assertion checks the temporary directory was actually removed.

## Merged ctl boundary

The parent reports baseline `7419e7c63` includes #1829 and `nix/macos-app/host/src/bin/macos-app-ctl.rs`'s `known_option` has no `lifecycle-fd` admission. Therefore merged ctl cannot exercise this inherited-fd contract today. The parent records its actual unknown-option rejection separately using the available test primitive binary:

```text
/nix/store/jl77zqm949yqpk8d96zmzw6c5g1vjgb8-macos-app-example/testPrimitives/bin/macos-app-ctl
```

A passing E5 fixture is native primitive/policy evidence only. It must not be reported as a passing merged-ctl lifecycle, secret-transfer, install-host, or select-generation integration test. No real host installation or generation selection occurs here.
