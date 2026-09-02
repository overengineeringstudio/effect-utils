# Local Disk Amortization Ledger

Date: 2026-09-01 — Host: dev3. Read-only inspection of live and stale
composition roots plus the branch worktree; no builds executed in existing
roots.

## Question

Does the adoption's content addressing amortize local disk — are identical
artifacts stored once per machine — or only remote execution, and what does
the per-worktree disk ledger look like today and after the Phase-4 authority
transfer?

## Method

Censused inode sharing (`nlink` distribution) inside the branch worktree's
`buck-out` after a cache-hit rebuild and inside a pre-decision-0022
composition root; measured combined versus separate `du` for twin composed
roots built from the same revision; counted machine-wide `buck-out` trees and
sizes; sized published editor views and checked their backing; read the
pinned Buck2 materializer source for local-CAS capability; read the
declared-closure assembler and editor-view publication code for their sharing
primitives; totaled per-worktree dependency state (node_modules, private pnpm
stores, buck-out).

## Result

The pinned Buck2 offers no local CAS: the materializer accepts only the
deferred materializer (unset/empty/`deferred`; `all` is rejected), which
defers writes but never shares bytes between roots. Twin composed roots
shared exactly 0 bytes (429 MB + 452 MB = 880 MB combined); 28 `buck-out`
trees machine-wide hold 9.2 GB with zero cross-root inode sharing. After a
remote-cache-hit rebuild the branch worktree's `buck-out` held 9,950 files
with none at `nlink > 1` — cache hits materialize plain files, stripping the
within-root hardlinks a local execution would have produced (the tui-core
dependency tree was present twice at 105 MB each). In the pre-0022 root,
38,809 of 41,557 files carried `nlink > 1`, but every sharing chain flowed
through pnpm store links, not Buck. The declared-closure assembler links with
a copy fallback on EXDEV; editor views publish via `cp -al` (~0 at publish)
and orphan to full copies when the backing artifact is garbage-collected
(86 MB of 131 MB observed orphaned). Per-worktree today: ~2.5 GB
(942 MB node_modules + 1.1 GB private pnpm store + 473 MB buck-out + views).
Extrapolated per composed root after Phase 4 (root install and node_modules
deleted; closure extracts plus assemblies): ~0.7–0.9 GB, duplicated per root
with no sharing mechanism.

## Conclusion

Content addressing amortizes remote execution and transfer, and
decision-0022 assembly makes dependency trees nearly free within one root —
but local disk is per-root by construction at this pin. Phase 4 cuts the
per-root price roughly 3x while composed-by-default multiplies roots, so
without a local sharing mechanism total disk trends flat-to-up. Reflink
assembly is the only mechanism that shares bytes across trees without
reintroducing shared mutable inodes.

## VRS Impact

Grounds [decision 0025](../../.decisions/0025-cow-reflink-local-disk-economics.md)
and the rewritten DEPS-R04. Corrects the assumption that the CAS design
already delivered disk amortization; the acceptance-criteria framing in the
execution epic references this ledger. Registers the hygiene targets: 9.2 GB
stale `buck-out` trees, orphaned editor snapshots, and the contaminated
immutable store commits measured the same day.
