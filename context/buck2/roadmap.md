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
- Implementation contraction lands with or before the slice: exactly 3,915
  lines are deleted — 2,390 evidence-regime lines under `scripts/buck2-*`
  (`dcbf241fa`); 1,494 synthetic-producer and input-plan lines under
  `buck2/evidence`, `genie/buck2`, and `packages/@overeng/tui-core/buck2`, plus
  their projection wiring (`95e4e171d`); and 31 replaced TypeScript check-path
  lines in root and dependent configs (`a19b24deb`). These commits and paths are
  the measurement sources; PR #1080 closes (built on the rejected
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
remaining `buck2:check` lane builds the real tui-core TypeScript action plus
the retained archive/product toolchain surface and is non-vacuous. The dormant
closure compiler and package-evidence pair are deleted because their evidence
regime retired before any live target admission; expiry is therefore
irrelevant. Warm unchanged execution is zero actions; a wiped second worktree
reported five cached actions and zero local actions, within BUCK-R07 budgets.

## Phase 2 — one-writable-mount workspaces

Architecture per [decision 0020](./.decisions/0020-one-writable-mount-workspaces.md)
(accepted 2026-08-27 after the e2e, adversarial, and workspace prototypes):
the store worktree path becomes the workspace root; every repo incl. the
owned one is a member cell at `repos/<name>`; the owned repo is the single
writable branch worktree; other members are read-only `cp -a` mounts with
RENAME_EXCHANGE advance.

- S0 guards FIRST: loud non-zero on non-symlink mounts; refuse to delete
  foreign real directories (18 exist).
- mr code change for the `CI=true` silent-detach trap (loud diagnostic or
  refusal).
- mr workspace materialization + composition-root generator (validated shapes
  per the 2026-08-26/27 experiments in 05-composition), incl. the six-point
  regeneration contract, capability-projection copy + `--check`, per-member
  `[project] ignore` audit, and workspace teardown command.
- Member portability in effect-utils: label rewrites, cross-cell visibility
  in genie's projection, delete the member `.buckconfig`.
- macOS verification: DONE 2026-08-27 (decision 0020 Amendment 1) — Darwin
  admission proceeds; cp -a clones on APFS (~0 disk); R6 post-condition
  mandatory on Darwin. Still gating the Darwin ADVANCE path only: FSEvents
  invalidation confirmation in a real login session, and the darwin digest
  probe on a profiled Mac worktree.
- tierA-scale build validation (fixture-scale digest claims are exact but
  small); root-cause the genrule lookup/upload key-mismatch anomaly.
- Legacy in-mount write consumers retire per consuming repository during its
  Phase-6 workspace adoption. Until then, that repository remains on
  symlink mounts with shared-cache writes disabled.

  | Consumer class                                  | Retirement change                                                                                                   | Admission proof                                                                          |
  | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
  | CLI executed from another member's source mount | Execute the already-packaged Nix CLI; dotfiles' bun-from-mount path is the first standalone cutover                 | Command succeeds with the source mount protected and unchanged                           |
  | Dependency task that writes another member      | Move the producer into that member's owned workspace; consume only committed source plus declared artifact overlays | Mutation sentinel remains clean across apply, task execution, and teardown               |
  | Live cross-workspace branch sharing             | Commit upstream in its owned workspace, advance the consumer lock, then re-apply                                    | No non-owned mount is branch-attached; the lock advance alone changes the consumer input |

  Each consumer owns its deletion-ledger entry and removes the symlink/no-cache
  exception in the same change that passes its admission proof.

- Cross-member TypeScript consumption: SETTLED as
  [decision 0021](./.decisions/0021-cross-member-types-dist-overlay.md) —
  dist overlay in mounts (cache-pulled, ignore-covered, manifest-declared);
  source aliasing across members retires when the overlay lands.
- Agent workflow contract rev 3 (authoring surface = the owned member;
  `repos/<other>` is a read-only build input); skill updates in dotfiles.
- Standalone-vs-composed and writable-vs-mount key stability hold per
  decisions 0014/0020; CI moves to the workspace shape.

## Phase 2b — declared dependency closure

- End-state per [decision 0022](./.decisions/0022-lockfile-derived-declared-closure.md):
  genie translates `pnpm-lock.yaml` into per-package fetch/extract targets and
  per-importer assembly targets; no ambient store, no install step, no deploy
  normalizer, no install descriptor.
- Built behind the two admitted packages (tui-core, tui-react) and landed with
  the Phase-2 cutover PR so the superseded provider never reaches `main`
  (q3, 2026-08-30). Deletion-ledger entry: `pnpm-deploy-normalizer.ts`,
  `pnpm-install-descriptor.ts`, `buck2-materializer.ts`, most of
  `materialization.bzl`, the ambient store warm lane, and the CI store cache
  lane.
- Closes the Phase-2 locked-member gate: there is no store to be read-only.
- Gates: sha256 sidecar generated and freshness-gated; cpu/os `select()`
  filtering; fresh-context budget (BUCK-R07) re-measured against the slower
  cold bootstrap; benchmark record per BUCK-R16.
- CI starts with registry downloads per run; caching is refined later (q4).

## Phase 3 — TypeScript surface widening

- Remaining TS package checks/builds admitted in value order; per-package
  devenv/pnpm build-path consumers deleted per admission.
- Workspace-sibling live links (symlink-back) are part of the standard rule.
- The coverage-asserted registry in `genie/tsconfig-projects.ts` has 38 root
  projects. tui-core and tui-react are admitted; 36 projects remain in both
  root solutions and leave them one deletion-ledger entry at a time.

- Admission 2 transfers `@overeng/tui-react` typecheck and declaration emit to
  `//packages/@overeng/tui-react:typecheck` and
  `//packages/@overeng/tui-react:dist`. Its package tree consumes tui-core only
  through `effect_utils//packages/@overeng/tui-core:dist`; utils and utils-dev
  enter as explicit content-tracked source siblings, with their required
  external modules provided by the package-local Buck `node_modules`
  materialization. Export type conditions and the member dist overlay point at
  Buck declarations, while runtime export defaults remain at source.
- Deletion-ledger entry 2 removes tui-react from both root TypeScript producers:
  the `tsconfig.check.json` solution used by `ts:check` and the
  `tsconfig.emit.json` solution used by `ts:build`. The six surviving dependent
  project-reference edges are deleted, and tui-react's ordinary editor config
  is write-free; dependents resolve its declarations through package exports.
  The Buck-only project config resolves its declared workspace inputs from the
  assembled package tree. The editor root install remains transitional until
  Phase 4 and is deliberately not deleted by this admission.

## Phase 4 — dependency-surface authority transfer (gated)

- End-state per [decision 0015](./.decisions/0015-buck-owned-dependency-surface.md)
  (authority) and [decision 0022](./.decisions/0022-lockfile-derived-declared-closure.md)
  (mechanism): Buck owns the editor surface; no hand-run `pnpm install`.
- The prune/install keying gate of decision 0015 Amendment 1 is retired: bounded
  fan-out is structural under the declared closure.
- The tui-core real-editor soak and scoped publication mechanism pass. The
  remaining gate is whole-required-consumer coverage: every editor/tool
  consumer gets a Buck-owned view with staleness checks, real source/dist
  sibling behavior is exercised, and test/Storybook/Genie/lint package-bin
  consumers leave the root install. Delete the root install and its task edges
  only with that final deletion-ledger proof.

## Phase 5 — Rust and products

- The Rust workspace has five members: otelite, otel-scrape, and the three Buck
  support crates. Admit deterministic Cargo operations first, then emit and
  independently import real otelite/otel-scrape BuildProducts before deleting
  Cargo/Nix source producers.
- Eight repository pnpm-deps FODs remain: ci-tools, Genie, mr, notion-cli,
  notion-md, npm-release, oxc-config, and tui-stories. Each disappears only
  after its real Buck product passes the independent Nix bridge (BUCK-R10).

## Phase 6 — second consumer (dotfiles)

- dotfiles consumes effect-utils targets through composition (success criterion
  6), compares producer/consumer action digests in CI, and proves zero local
  execution from the shared cache. The same admission deletes its source-mount
  CLI path, dependency writers, and live cross-workspace mutation paths; until
  then symlink compositions remain no-upload.

## Deferred / parked

- Remote execution workers (NativeLink is the designated candidate if RE enters
  scope; cache swap is cheap because CAS state is disposable).
- OCI product distribution durability machinery: parked per
  [decision 0013](./.decisions/0013-shared-cache-foundation.md) partial
  supersession of decision 0008.
- pnpm store consolidation on dev3 — moot under decision 0022 (no ambient
  store); the developer-time pnpm store is not a Buck concern.
- pnpm 12: revisit when it is the `latest` dist-tag and packaged in nixpkgs;
  under decision 0022 pnpm runs only at developer resolution time.
- Bun as installer: revisit only if a released Bun emits per-package
  self-contained trees and nixpkgs carries it; disqualified today on a silent
  `patchedDependencies` drop. Under decision 0022 the fetcher is irrelevant.
