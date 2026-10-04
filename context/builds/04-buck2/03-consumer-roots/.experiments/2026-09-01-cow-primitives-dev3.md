# CoW Primitives and Copy Costs on dev3

Date: 2026-09-01 — Host: dev3 (NixOS, ext4 root on LVM/md-RAID NVMe; ZFS
`bulk` pool on rotational disks, zfs 2.4.3, block_cloning active) — GNU
coreutils from the Nix store. Scratch in /tmp and a bulk-pool dataset, removed
after the runs.

## Question

Does the decision-0020 mount mechanism already deliver copy-on-write
economics per platform, and which 0-copy alternatives (reflink, overlayfs)
are viable on the fleet's Linux host — for member mounts, dependency trees,
and worktree-scale duplication?

## Method

Measured `cp -a` of a real member-mount tree (29 MiB, 3,539 entries from a
store commit worktree) and a node_modules-scale tree (942 MB, 41,520 files)
on ext4. Repeated both on the ZFS pool with `--reflink=auto` (default) and
`--reflink=always`, verifying clone reality via `zpool` `bcloneused` /
`bclonesaved` deltas, inode independence via `stat`, and content equality.
Probed RENAME_EXCHANGE (`mv -T --exchange`) on ZFS, dirty-source clone
latency (`zfs_bclone_wait_dirty=1`), unprivileged kernel overlayfs in a
user/mount namespace, fuse-overlayfs 1.17 (mount visibility, read tax via a
sha256 walk, write rejection), inode sharing across the five live effect-utils
worktrees' `node_modules` versus their pnpm stores, and `git checkout-index`
cost for the tracked tree. Surveyed host storage (findmnt/lsblk, LVM free
extents, pool capacity).

## Result

ext4: member mount `cp -a` 0.43 s cold / ~0.10 s warm at 29 MiB real disk;
node_modules-scale 5.97 s and 942 MB real disk. ZFS: the same `cp -a`
produced genuine block clones (bcloneused 33.2 → 34.0 G) with independent
inodes and `nlink=1` — the R6 independent-inode check passes unchanged —
in 3.10–4.15 s for the 942 MB tree at ~0 marginal disk; `mv -T --exchange`
works; a freshly written source cloned in 28.9 s until synced (isolated: a
dirty 256 MB file cloned in 4.04 s, 0.01 s after `sync`). Overlayfs:
namespace mounts are invisible to outside processes (daemon, watchman,
editors); the mountpoint cannot be RENAME_EXCHANGEd (EBUSY); fuse-overlayfs
is visible and kernel-enforces read-only but costs ~4x on reads (0.22 s vs
0.05 s sha256 walk). Worktree dedup: two worktrees on the shared pnpm store
share 90% via hardlinks (second copy 92 MB marginal, sampled inode
`nlink=317` in both); three worktrees on private stores share nothing.
`git checkout-index` of the tracked tree: 0.20 s. Storage: no reflink-capable
filesystem exists under any composing workspace (all ext4); LVM has 0 free
extents and the NVMe pair is fully consumed; the only CoW-capable storage is
the rotational bulk pool (19.2 T free).

## Conclusion

The mount mechanism is already a per-platform CoW dispatcher: GNU `cp -a`
selects clonefile on APFS (decision 0020 Amendment 1) and FICLONE wherever
the filesystem offers it; the R6 gate admits clones and rejects hardlinks by
construction. Linux is missing a filesystem, not code. Overlayfs (kernel and
FUSE) is structurally incompatible with the RENAME_EXCHANGE advance and is
rejected. Member-mount copying on ext4 is an acceptable price (~0.2 s /
29 MiB); the dominant duplication is node_modules-class trees, governed by
pnpm store fragmentation, not by the mount mechanism. Fresh-write clone
stalls are a non-issue for the immutable synced store but forbid a naive
stage-then-clone pipeline.

## VRS Impact

Grounds [decision 0025](../../.decisions/0025-cow-reflink-local-disk-economics.md)
(reflink-first assembly; fleet filesystem requirement) and the DQ2
resolution. Confirms the decision-0020 mechanism needs no change for CoW
adoption. Un-parks pnpm store consolidation in the roadmap: the measured
90%-dedup-where-shared result contradicts the "moot under 0022" parking
while 36 of 38 projects still require the root install.
