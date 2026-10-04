# DELTA-001: Assembler still hardlinks pending decision 0025

Status: open

## Divergence

The rewritten DEPS-R04 requires reflink-first assembly with independent
inodes and rejects hardlink sharing into assembled trees. The live assembler
still links extract artifacts into assembled trees (copy fallback on EXDEV),
so assembled files share inodes with extract outputs wherever links succeed.

## VRS

- [Decision 0025](../../.decisions/0025-cow-reflink-local-disk-economics.md)
  ratifies reflink-first assembly and gates the flip on a spike proving a
  real `buck2` build over a reflink-assembled tree.
- [DEPS-R04](../requirements.md) carries the target contract.
- [2026-09-01 amortization ledger](../.experiments/2026-09-01-local-disk-amortization-ledger.md)
  records the observed link behavior.

## Implementation

`assemble-node-modules` uses `link()` with a copy fallback; `package-tree`
copies with `COPYFILE_FICLONE` (a full copy on ext4). Published editor views
use `cp -al`.

## Direction

update implementation

## Resolution Signal

Land the reflink-first assembler change behind the decision-0025 spike —
FICLONE clone attempt first, plain copy fallback, never `link()` into
assembled trees. The delta closes when the assembler produces no `nlink > 1`
files in assembled trees and the decision-0025 build spike passes over a
reflink-assembled tree.
