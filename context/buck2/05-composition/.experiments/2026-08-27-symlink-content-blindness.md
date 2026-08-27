# Symlink Mounts Make Buck2 Blind to Member Content

Date: 2026-08-27 — Host: dev3 — Buck2 pin 2026-04-14-7600cb80; upstream HEAD
2026-08-26 also examined.

## Question

Does any Buck2-side mechanism (config, newer version, canonical-path
convention) make absolute-symlink member mounts digest-compatible with real
directories — and what exactly enters the digest under a symlinked mount?

## Method

One byte-identical composition root; per measurement `buck2 kill` +
`rm -rf buck-out`; digests from `buck2 log show`; a source-edit control on
both mount shapes; mechanism confirmed by reading buck2 source at the exact
pin (and diffing 51 relevant commits to 2026-08-26 HEAD); all 180
`BuckconfigKeyRef` names enumerated from source; upstream issues/PRs read.

## Result

- Real-dir control: base digest changes on a one-line source edit and reverts
  exactly. Absolute-symlink mount: **the same edit leaves the action digest
  unchanged** — same key, two different `artifact.tar` contents (sha
  `eaa4cb22…` vs `a35e3875…`). Warm daemon: the symlink shape re-runs ZERO
  actions after the edit and serves the stale artifact.
- Mechanism (source-verified): `read_path_metadata`
  (`buck2_common/src/io/fs.rs:293-323`) walks the project-relative path and
  returns on the first symlink component whose target string `has_root()` —
  no canonicalization, no containment check. The subtree becomes
  `ExternalSymlink` with `deps: None`; the serializer writes the target
  STRING verbatim into the input Merkle tree. The member's files are not
  inputs at all. BUCK loading still works (a different read path follows the
  link via the kernel), which is why builds succeed silently.
- Discriminator is ABSOLUTENESS, not project escape: an absolute symlink to a
  target INSIDE the project root is equally blind; a RELATIVE symlink whose
  target stays inside the project root is fully content-tracked
  (digest-equivalent to a real dir, edits invalidate); a relative symlink
  escaping the root is a hard error. Hardlink farms (`cp -al` from an
  out-of-project store) are digest-identical to real dirs and content-tracked
  — admissible where the mount is a read-only build input.
- Canonical-target dodge is dead twice: a stable-but-blind digest is worse
  than a split, and the ref-embedded store path is a PERMANENT key whose
  content advances per commit — first build on a branch would be served for
  every later commit, surviving `buck2 kill` and local wipes once a shared
  cache holds it.
- No Buck2 lever exists: no `resolve_symlinks`/`canonicalize`/`allow_symlinks`
  key at the pin; upstream (issue #474, PR #1286 closure 2026-05-19) states
  the direction is BANNING symlinks, not handling them; the pin→HEAD diff
  changes nothing relevant and HEAD adds a test preserving verbatim target
  serialization; Meta's internal answer is EdenFS (real mount paths),
  compiled out of OSS builds.
- Live-worktree observation: `repos/effect` in the buck2 worktree is an
  absolute symlink into the store — harmless today (no member cells, no cache
  upload in the live `.buckconfig`), poisonous the moment members become
  cells with upload enabled.

## Conclusion

Filesystem-level content-realness is the only sound route; the requirement is
"member bytes reachable without traversing an absolute symlink, relative
links normalized in-root" — satisfied by real dirs, hardlink farms
(read-only mounts), and in-root relative symlinks. A symlink-mounted
composition must never write to a shared cache. Verify no real (non-spike)
build ever uploaded to the fleet bazel-remote from a symlink-mounted root;
purge any such entries.

## VRS Impact

Rewords COMP-R08 (content-reachability, hardlink/in-root-relative admission,
read-only caveat) and COMP-R10 (correctness, not cache hygiene; symlink
mounts + cache upload must never combine). Kills the canonical-path
alternative and the pin-bump hope for decision 0014's mount question. Adds
two operational actions: guard the existing `repos/effect` symlink before
member cells land, and audit the shared cache for symlink-rooted uploads.
