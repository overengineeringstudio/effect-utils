# Buck2 Adoption Roadmap

Derived, non-timeless sequencing. The VRS describes the system; this file
describes the order in which authority moves and what each move deletes.
Supersedes the lane/PR plan embedded in
[decision 0012](./.decisions/0012-vertical-slice-replay-phase.md) and the
roadmap formerly referenced from
`context/dependency-materialization/05-buck2-evidence/`.

## Sequencing principle

Whole-repo exclusivity is the endgame (BUCK-R01); admission order is by value:
expensive, high-leverage operations first, cheap operations when migrating them
provably pays. Every step lands its deletion-ledger entry in the same change.

## Phase 0 — shared cache foundation (external dependency)

- bazel-remote cache-only service on dev3: dotfiles#2009. Consumer trust and
  admission sequencing: effect-utils#1054.
- Client contract facts are recorded in
  [decision 0013](./.decisions/0013-shared-cache-foundation.md).

## Phase 1 — vertical slice with reuse (tui-core)

- tui-core typecheck under Buck2 using the validated tsgo rule and
  manifest-only `pnpm deploy` materialization; its devenv check path deleted in
  the same change (first deletion-ledger entry).
- Measured against BUCK-R07 budgets; cache canary across two worktrees proves
  BUCK-R06 zero-re-execution.
- Product path retained: strict v1 product -> independent Nix import (existing
  bridge tests).

## Phase 2 — composition root

- genie projects the synthesized composition root (.buckconfig cells,
  canonical mounts, shared platform labels); megarepo materializes members.
- Standalone-vs-composed key stability holds per
  [decision 0014](./.decisions/0014-megarepo-cell-composition.md); CI moves to
  the composition shape.

## Phase 3 — TypeScript surface widening

- Remaining TS package checks/builds admitted in value order; per-package
  devenv/pnpm build-path consumers deleted per admission.
- Workspace-sibling live links (symlink-back) are part of the standard rule.

## Phase 4 — dependency-surface authority transfer (gated)

- End-state per [decision 0015](./.decisions/0015-buck-owned-dependency-surface.md):
  Buck owns the editor surface; no hand-run `pnpm install`.
- Gate (BUCK-R12): per-cell pruned-lockfile keying built and measured (kills
  manifest-change fan-out), plus a real-editor soak on one package. Until the
  gate passes, the root install is transitional and listed in the deletion
  ledger.

## Phase 5 — Rust and products

- Rust operations admitted per the rust-cargo binding decisions
  (0017–0019); complete-lock Nix vendoring dissolves per BUCK-R10 as products
  cross the bridge.

## Phase 6 — second consumer (dotfiles)

- dotfiles consumes effect-utils targets through the composition (success
  criterion 6); sharing mechanics (in-repo rules vs extracted package) decided
  then, with a real consumer's requirements in hand.

## Deferred / parked

- Remote execution workers (NativeLink is the designated candidate if RE enters
  scope; cache swap is cheap because CAS state is disposable).
- OCI product distribution durability machinery: parked per
  [decision 0013](./.decisions/0013-shared-cache-foundation.md) partial
  supersession of decision 0008.
- Buck2 pin bump toward upstream (post Phase 1 merge).
- pnpm store consolidation on dev3 (one shared store per filesystem) — disk
  work, orthogonal to Buck authority but required for BUCK-R08 economics.
