# macOS APFS Primitives for Workspace Mounts

Date: 2026-08-27 — Host: mbp2021 (macOS 26.5.1, arm64 T6000, APFS boot
volume), driven over ssh from dev3 — GNU coreutils 9.11 from the Nix store.

## Question

Do the primitives decision
[0020](../../.decisions/0020-one-writable-mount-workspaces.md) makes
load-bearing — RENAME_EXCHANGE mount advance, `cp -a` materialization,
chmod-based protection, and the "nothing writes into the mount" watcher claim
— hold on macOS/APFS, so Darwin admission can proceed?

## Method

Replicated the Linux probes from
[2026-08-27-readonly-mount-e2e.md](./2026-08-27-readonly-mount-e2e.md) on
mbp2021 in a scratch dir: the exchange tested at two layers (the pinned GNU
`mv -T --exchange --no-copy` binary AND a hand-compiled `renamex_np` +
`RENAME_SWAP` syscall probe, so a failure could be attributed); atomicity via
60 consecutive exchanges of a 201-file dir against 4 concurrent reader
threads; cross-device behavior against a real HFS ramdisk (distinct
`st_dev`); `cp -a` semantics on a 3000-file/36 MiB store-shaped tree plus an
800 MiB clone-vs-copy timing discriminator; protection and teardown probes on
444/555 trees; a manifest post-condition (R6) comparing mount vs store; a
watchman cookie-placement capture caught mid-sync; a case-collision probe on
the case-insensitive volume. Pre-existing watchman and buck2 daemons on the
CI runner were left untouched; scratch removed.

## Result

- **RENAME_EXCHANGE — PASS at both layers.** GNU `mv -T --exchange` swaps
  non-empty dirs (rc=0, contents crossed); the raw `renamex_np(RENAME_SWAP)`
  probe confirms gnulib routes to the native syscall — the pinned Nix GNU
  `mv` is usable as-is, no native helper needed. Atomicity: 60 swaps, median
  5.11 ms, 42,619 reader samples, 0 ENOENT, 0 partial content, only the two
  whole-state sentinel values ever observed. Cross-device fails correctly at
  both layers (EXDEV, `--no-copy` prevents any fallback copy; both sides
  unchanged). Plain `rename(2)` over a non-empty dir is ENOTEMPTY, so
  `--exchange` is required, as on Linux.
- **`cp -a` — PASS, with an economics finding: GNU `cp -a` CLONES on APFS.**
  Modes (444/755), mtimes, relative and absolute symlinks, and empty dirs all
  preserved (3000 files / 36 MiB in ~295–313 ms). The binary imports
  `_fclonefileat`; on an 800 MiB non-sparse file GNU `cp -a` took 44 ms vs
  1012 ms for BSD `/bin/cp` (real copy) — copy-on-write clones with
  independent inodes (links=1, distinct ino). Mechanism C therefore costs
  ~0 incremental disk per mount on Darwin without reintroducing hardlink
  coupling: a chmod+w edit through the mount left the store byte-identical
  (sha `716dab49…`) and still mode 444.
- **Protection — PASS, identical to Linux.** In-place truncate, append,
  create, mkdir, unlink, and rename-replace all DENIED on the protected
  tree; owner `chmod` remains ALLOWED (the R4 hash-vs-locked-sha detector is
  what catches that, as on Linux); no ACLs present to override POSIX bits.
  `rm -rf` of a protected tree fails with the tree fully intact; the
  dirs-only-unprotect teardown works.
- **R6 manifest post-condition — MATCH** (files+symlinks+modes manifest
  `7cd82952…`, 3002 entries, mount == store; 0 files off 444, 0 dirs off
  555). This closes an assertion the Linux run stated but never measured.
- **Watchman/FSEvents — cookie placement answered; invalidation
  unverifiable over ssh.** The sync cookie lands at the writable composition
  ROOT (`.watchman-cookie-…` in the watch root); zero cookies, zero
  mtime/ctime disturbances, and zero `.DS_Store` inside the protected mount
  — the "nothing writes into the mount" claim holds under FSEvents for
  placement. But FSEvents delivers no events at all to sshd-spawned
  processes on this host (TCC/no GUI session; control: a plain writable dir
  never observed a `touch` either), so invalidation ACROSS the exchange is
  UNVERIFIED on Darwin and needs a real login session (or launchd watchman
  with Full Disk Access). A green ssh-driven watchman test would be a false
  negative.
- **Buck2 digest probe — skipped** per instruction: no devenv profile exists
  on any Mac worktree, and hand-building a cell on the ARM CI runner risks a
  stray daemon holding locks. Remaining work: real-dir vs `cp -a` digest
  equality on a Mac worktree with a profile, or in CI.
- **Darwin-specific caveats for the mr implementation:** (C1) the boot
  volume is case-INSENSITIVE APFS — a store tree containing colliding paths
  silently collapses to one file at materialization with no `cp` error
  (effect-utils currently has 0 colliding tracked paths; the R6 manifest
  check catches the collapse loudly via entry count and hash — make R6
  MANDATORY on Darwin rather than adding a separate pre-flight). (C2) the
  no-`-T` misuse fails SAFE on APFS (errors with both sides intact, unlike
  Linux where it moved the staging dir into the mount). (C3) GNU `mv`'s
  errno rendering is unreliable on Darwin (ENOENT printed as "Unknown system
  error") — mr must branch on exit codes, never parse `mv` stderr. (C4) the
  per-platform cost table differs: Darwin tier-A disk per mount is ~0
  (clone), not 31 MiB.

## Conclusion

Every load-bearing primitive passed on APFS: Darwin admission for the
one-writable-mount workspace shape can proceed, with the production Nix GNU
`mv` as the exchange binary and mechanism C strictly dominating on Darwin
(clone economics, no coupling). Hold the Darwin advance path from SHIPPING —
not from admission — until FSEvents invalidation across the exchange is
confirmed in a real login session and the real-dir vs `cp -a` digest probe
runs on a Mac with a devenv profile.

## VRS Impact

Partially discharges decision 0020's macOS verification obligation
(primitives verified; FSEvents invalidation and the Darwin digest probe
remain, gating the Darwin advance path only). Adds two rules to the mr
implementation contract: the R6 manifest post-condition is mandatory on
Darwin (covers the case-insensitivity collapse, the COMP-R10 shape), and mr
branches on exit codes rather than `mv` stderr text (C3).
