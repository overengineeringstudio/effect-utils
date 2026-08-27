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

- Cache wiring first: the config-only diff (executor cache fields + SHA256 +
  upload defaults + devenv-generated `.buckconfig.local`), the
  `--no-remote-cache` flags deleted from the buck2 devenv tasks, and the
  validated two-worktree canary run against the deployed service.
- tui-core typecheck under Buck2 using the validated tsgo rule and
  manifest-only `pnpm deploy` materialization; its devenv check path deleted
  in the same change (first deletion-ledger entry) via the spiked partition
  mechanism
  ([02-execution/.experiments/2026-08-26-check-surface-partition.md](./02-execution/.experiments/2026-08-26-check-surface-partition.md)):
  `exports` gains a `types -> dist` condition, references drop from the five
  dependents and BOTH root solutions (check and emit), and CI materializes the
  Buck2 artifact before `ts:check:strict` — the ordering gate without which
  the transfer is fictional.
- Implementation contraction lands with or before the slice: the branch's
  evidence regime (~5.6k lines: benchmark harness, enumerated input-plan
  chain, synthetic foundation gate, per-invocation isolation dirs) is deleted
  per the 2026-08-26 audit; PR #1080 closes (built on the rejected
  Nix-materialized-deps authority), #1081 parks as Phase 5 reference.
- Measured against BUCK-R07 budgets; BUCK-R06 zero-re-execution proven via the
  canary runbook.
- Product path retained: strict v1 product -> independent Nix import (existing
  bridge tests).

**Milestone completed 2026-08-26.** The integrated gate is recorded in
[2026-08-26-tui-core-authority-transfer.md](./02-execution/.experiments/2026-08-26-tui-core-authority-transfer.md):
representative failure, relevant/irrelevant causality, hostile environment,
strict task ordering, and fresh-context cache reuse all pass. Deletion-ledger
entry 1 removes tui-core from both root TypeScript solutions and deletes the
synthetic `buck2_foundation` / `typescript_input_plan` evidence producers; the
remaining `buck2:check` lane builds the retained toolchain surface and is
non-vacuous. Warm unchanged execution is zero actions; a wiped second worktree
reported five cached actions and zero local actions, within BUCK-R07 budgets.

## Phase 2 — composition root

- mr gains real-directory member materialization (COMP-R10) — the
  precondition for any shared cache namespace; today's absolute-symlink
  mounts silently split digests.
- The composition-root generator lands in mr (validated shape per
  [05-composition/.experiments/2026-08-26-composition-root-real-repos.md](./05-composition/.experiments/2026-08-26-composition-root-real-repos.md)),
  with the member-portability changes in effect-utils (label rewrites,
  cross-cell visibility in genie's projection, delete the member
  `.buckconfig`).
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
- The two-stage canonical prune/install key and normalization gate landed and
  was measured with the Phase-1 tui-core transfer; unrelated manifest churn
  executes only the small prune action.
- Remaining gate: a real-editor soak on one package and the editor publication
  mechanism. Until that passes, the root install is transitional and listed in
  the deletion ledger.

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
- pnpm store consolidation on dev3 (one shared store per filesystem) — disk
  work, orthogonal to Buck authority but required for BUCK-R08 economics.
