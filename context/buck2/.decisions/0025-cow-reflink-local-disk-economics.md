# 0025 CoW Reflink Local-Disk Economics

Status: accepted

## Context

The adoption's disk-efficiency goal was assumed to follow from content
addressing, but the shared CAS amortizes only remote execution and transfer.
At the pinned Buck2 revision (2026-08-22) there is no local CAS: the only
materializer is the deferred materializer, which skips writes but never shares
them. Every composition root's `buck-out` holds full independent bytes, and a
remote-cache hit materializes plain files even where a local execution would
have produced hardlinks. With composed workspaces becoming the default
worktree shape, per-root duplication multiplies by the number of live
worktrees. Separately, DQ2 recorded that hardlink aliasing inside `buck-out`
is unsafe because a write through an assembled tree corrupts the shared
extract artifact.

## Evidence and Argument

Measured on dev3, 2026-09-01
([local-disk amortization ledger](../03-materialization/.experiments/2026-09-01-local-disk-amortization-ledger.md),
[CoW primitives](../05-composition/.experiments/2026-09-01-cow-primitives-dev3.md)):

- Twin composed roots share exactly 0 bytes (429 MB + 452 MB = 880 MB
  combined); machine-wide 28 `buck-out` trees hold 9.2 GB with no cross-root
  inode sharing.
- A cache-hit rebuild left the branch worktree's `buck-out` with 9,950 files
  and zero `nlink > 1` — remote hits strip even within-root hardlinks.
- Within one root, declared-closure assembly is nearly free where links
  survive: 13.4 MB marginal on 609 MB of content (decision 0022 prototype).
- CoW clones satisfy both safety contracts at once: on the dev3 ZFS pool,
  `cp -a` produced genuine block clones with independent inodes and ~0
  marginal disk; the composition R6 independent-inode check passes and
  RENAME_EXCHANGE advance works. On APFS the same GNU `cp` already clones
  (44 ms vs 1012 ms for 800 MiB, decision 0020 Amendment 1).
- ext4 (the current dev3 worktree filesystem) has no reflink support, and no
  CoW-capable NVMe capacity exists on the host today.

Johannes resolved the structured questions on 2026-09-01: commit to CoW
economics rather than accepting per-root duplication, and split the normative
placement between this repository and the fleet.

## Options

| Decision              | Selected                                            | Alternatives rejected                                                                                                         |
| --------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Local-disk strategy   | Reflink-first CoW assembly                          | Accept per-root duplication (bounded by GC); machine-level shared extract store (reintroduces the ambient state 0022 deletes) |
| Requirement placement | DEPS-R04 rewrite + fleet-VRS filesystem requirement | Top-level BUCK-R17 (binds an actor outside repo authority); non-normative note only (intent evaporates at refresh time)       |

## Decision

Assembly becomes reflink-first: assembled trees clone from Buck extract
artifacts with copy-on-write reflinks where the filesystem supports them, and
fall back to plain copies where it does not; assembled files always carry
independent inodes; hardlink sharing into assembled trees is rejected.
DEPS-R04 is rewritten accordingly, and this resolves DQ2 — reflinks provide
independent inodes with shared blocks, eliminating the write-through
corruption hazard instead of documenting it.

The filesystem constraint lives in the fleet VRS (dotfiles): the next storage
provisioning or refresh on build hosts MUST provide a CoW-capable filesystem
for worktree/composition volumes. This repository does not assert requirements
it cannot enforce.

Gate before flipping the default assembly mode: one spike proving a real
`buck2` build over a reflink-assembled tree (key stability, R6 checks,
overlay behavior).

## Consequences

- Darwin/APFS receives full CoW economics as soon as the assembler change
  lands; ext4 hosts keep copy semantics until the fleet requirement is
  satisfied at a storage refresh.
- Until the assembler change lands, the implementation still hardlinks —
  recorded as a staged divergence in
  [.delta/DELTA-001](../03-materialization/.delta/DELTA-001-assembler-hardlinks-pending-0025.md).
- A hygiene pass is owed regardless of filesystem: GC of stale `buck-out`
  trees and stale composition roots, purge of contaminated immutable store
  commits plus a store-contamination guard, GC of orphaned editor snapshots,
  and pnpm store consolidation stays live (un-parked) until Phase 4 deletes
  the root install.
- The remote cache remains the sole cross-machine amortization mechanism;
  local CoW is cross-root amortization on one machine.
