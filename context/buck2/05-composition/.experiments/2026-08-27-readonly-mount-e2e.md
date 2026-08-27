# Read-Only Mount Mechanisms End to End

Date: 2026-08-27 — Host: dev3 (ext4 store filesystem) — Buck2 pin
2026-04-14-7600cb80 with watchman.

## Question

Which mechanism realizes proposed decision 0020's content-real READ-ONLY
member mounts through the full lifecycle — materialize from a lock, build,
lock-advance regeneration under a live daemon, dirty detection — and does the
read-only premise survive a systematic write inventory?

## Method

Both mechanisms named in the proposal (detached git worktree; write-protected
`cp -al` hardlink farm) plus a `cp -a` real-copy control were driven through
the identical lifecycle in a scratch composition: materialize at locked rev,
copy in the capability projection, write-protect, real Buck2 build against
fresh cold real-dir control digests (prior anchors were stale against moved
branch HEAD), simulated one-commit lock advance with atomic regeneration
while a Buck2 daemon and watchman stayed live, a dirty-mount probe, and a
fence-based write inventory (nothing assumed writable or read-only without a
probe). Worktree bookkeeping was scale-tested against one bare repo.

## Result

- **Hardlink farm disqualified on correctness.** File mode is inode metadata
  shared across hardlinks: `chmod -R a-w` on the farm write-protected THE
  STORE (source file 644 -> 444, same inode), and routine `chmod -R u+w`
  cleanup un-protected the store twice by accident. One `chmod +w` plus an
  append through a mount corrupted the shared store (member file sha
  `9a33264a` -> `ab7387cf`), and regeneration then laundered the corruption
  into a digest under a key claiming to be the advanced commit — the
  COMP-R10 cache-poisoning class with fleet-wide blast radius. Hard
  same-filesystem constraint besides (`cp -al` cross-device = EXDEV).
- **Detached worktree cannot regenerate atomically.** In-place
  `git checkout` under protection half-failed and STILL MOVED HEAD — leaving
  HEAD at the new commit with old bytes, which Buck2 silently built
  (`checkout -f` is mandatory, not stylistic). The atomic-swap variant
  builds correctly but crosses worktree registrations, and a routine
  follow-up `git worktree prune` orphans the live mount
  (`git -C <mount> status` -> "fatal: not a git repository"). Atomic swap
  and git-native dirty detection are mutually exclusive without an
  unprotect-and-repair step.
- **The `cp -a` control wins.** Independent inodes (link count 1) with 444
  file modes INHERITED from the store — the hardlink farm's protection with
  none of its coupling. Digest matches the cold real-dir control at both
  revisions. Dirty probe fully isolated: an edit through the mount left the
  store byte-identical and still 444; dirtiness is detected by hashing the
  mount against the locked store sha. Advance = stage `cp -a` of the new rev
  out of the way (41 ms, mount untouched) then one
  `mv -T --exchange --no-copy` (RENAME_EXCHANGE, 4 ms); the live daemon +
  watchman re-ran exactly one action (Commands: 1, cached: 0) to the exact
  cold-control digest. No bookkeeping, no registration, no same-filesystem
  constraint against the store.
- Costs at the tracked tier (3214 files / 31 MiB): `cp -al` ~80 ms / ~0
  disk; `cp -a` ~200 ms / 31 MiB; `git worktree add` ~220 ms / 31 MiB. The
  hardlink farm's ~2.5x speed and disk saving is the trade being declined.
- **Write inventory (fence method):** buck2, watchman, and `git status`
  wrote NOTHING into the mount — watchman watches the COMPOSITION ROOT via
  inotify, with no cookies or state files in mounts; only `buck-out` at the
  root is written. Real writers found: (W1/W2) the worktree mechanism's own
  `git checkout` and `git worktree repair` need the mount writable (repair
  fails: "could not open <mount>/.git for writing"); (W3) genie GENERATE
  explicitly chmods read-only targets to 0644 and creates
  `<cwd>/tmp/genie-locks` — it defeats mode protection by design and must
  never run with cwd inside a mount, while `genie --check` is mount-safe
  (read-only, stages in os.tmpdir), so the GRAPH-R05 freshness gate holds;
  (W4) the editor view per 03-materialization spec:134-147
  (`packages/.editor-view` + `.publish.lock` + `.store/`) lives INSIDE the
  member tree, so a member's editor view cannot publish into a read-only
  mount — consistent with no-authoring-in-composition for builds, but a
  composed DEV workspace gets no editor view for mounted members (open gap
  for a future writable/dev tier); (W5) pnpm workspace manifests do not glob
  into `repos/**` in effect-utils or the dotfiles root (manifest-derived
  finding, not executed).
- Worktree-scale side-findings (load-bearing if a git-based option is ever
  revived): multiple detached worktrees at the SAME sha are permitted (27 +
  26 simultaneously against one bare repo); 50 adds mean 79 ms with no
  count degradation; `git worktree list` at 54 entries 87 ms; plain
  `git worktree prune` reclaimed 50 missing dirs in 22 ms with NO expire
  window.
- Six-point regeneration contract for mr (full text retained in the run's
  findings): store invariant is files 444 / dirs 755 and never re-chmod'd;
  the materialize -> capability-copy -> protect ordering is load-bearing;
  the capability copy is NOT optional (`.buck2/capabilities` is gitignored
  and a mount without it fails at LOAD); advance is stage-plus-exchange;
  dirty refusal is hash-vs-locked-sha; teardown chmods dirs only, because
  plain `rm -rf` of a protected mount fails.
- **macOS unknowns (genuine blockers to verify):** RENAME_EXCHANGE is now
  the load-bearing primitive — Linux uses `renameat2` via GNU
  `mv -T --exchange --no-copy`; macOS has `renamex_np`/RENAME_SWAP and the
  system mv is not GNU. Whether the pinned GNU mv maps onto RENAME_SWAP on
  APFS is unverified, as are `cp -a` mode preservation on APFS,
  chmod-protected directory semantics, and watchman-under-FSEvents cookie
  placement (the "nothing writes into the mount" result was measured under
  inotify only).

## Conclusion

Neither mechanism named in proposed decision 0020 survives its own
lifecycle: the hardlink farm write-protects and can corrupt the store
through shared inodes, and the detached worktree cannot regenerate
atomically without either building stale bytes or orphaning itself on
prune. The winning mechanism is the third one: `cp -a` real-directory copy
from an immutable store (files 444 / dirs 755) with stage-plus-
RENAME_EXCHANGE advance — digest-correct, dirty-isolated, 4 ms atomic
advance under a live daemon, no bookkeeping, no filesystem coupling. The
read-only premise holds for the build path; the enumerated writers (genie
GENERATE cwd discipline, in-tree editor views) bound what a read-only mount
can host.

## VRS Impact

Rewrites proposed decision 0020's mechanism clause ("detached git worktree
or write-protected hardlink farm" -> `cp -a` from immutable store +
RENAME_EXCHANGE advance) and supplies the regeneration contract for the
COMP-R08/R10 implementation in mr. Records the genie-GENERATE cwd rule and
the member editor-view gap as read-only-mount boundary facts; names the
macOS RENAME_SWAP/APFS verifications required before fleet claims extend to
Darwin.
