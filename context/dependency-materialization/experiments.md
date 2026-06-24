# Dependency Materialization Experiments

This file records non-normative evidence for the dependency materialization
design. Normative behavior lives in [spec.md](./spec.md).

## 2026-06-22: Shared Store Research Imported From dotfiles

Hypothesis:

- Host-wide pnpm sharing is worth preserving, but raw profile-local prune and
  repair commands are unsafe when profile metadata shares a package files pool.

Source:

- schickling/dotfiles#1125 and the research branch
  `schickling/2026-06-22-pnpm-store-research`.

Result summary:

- split stores with separate metadata and a shared `v11/files` pool can be
  corrupted by pruning through only one profile;
- `pnpm store status` can report clean while a sibling offline reinstall fails;
- shared-pool GC must mark from every active root or refuse to sweep;
- isolated stores are simpler but lose a large host-wide byte and file-count
  win;
- Darwin pnpm can exit 134/137 after materialization, so wrappers classify
  those exits only after projection health checks.

Conclusion:

- effect-utils should keep the shared profile vocabulary but make repair,
  prune, and GC authority explicit in the dependency materialization profile.

## 2026-06-24: Pure Install Versus Missing `.bin`

Hypothesis:

- The `schickling.dev` CI failures are missing executable projection, not a
  reason to allow pnpm lifecycle scripts.

Method:

- Investigate effect-utils PR #829 comment
  https://github.com/overengineeringstudio/effect-utils/pull/829#issuecomment-4786860545.
- Compare synthetic fixtures with a real schickling.dev dependency graph.
- Review pnpm docs for `--ignore-scripts`, rebuild, approve-builds, and bin
  linking surfaces.

Result:

- A synthetic package did not reproduce missing `.bin` under
  `--ignore-scripts`.
- A real schickling.dev graph did reproduce missing app-local bins after a pure
  install. Bins appeared when scripts were enabled, but that also admitted
  lifecycle work and is not an acceptable policy.
- `@pnpm/link-bins` shows bin linking is separable from lifecycle execution.

Conclusion:

- effect-utils should keep `--ignore-scripts` mandatory and add a pure
  manifest-based bin projection and repair layer.

## 2026-06-24: Prepared FOD `.bin` Surface

Hypothesis:

- Prepared pnpm dependency FODs should be strict data artifacts and should not
  archive executable `.bin` projection state.

Source:

- schickling/dotfiles#1156 investigation note.

Result:

- The prepared dependency builder already runs
  `pnpm install --frozen-lockfile --no-optional --ignore-scripts`.
- The effect-utils common deps prepared artifact included 40 `.bin` directories
  and 88 shims.
- The durable-workflows prepared artifact included 12 `.bin` directories and
  29 shims.
- Removing `.bin` changed the recursive hash for both artifacts, so `.bin` is a
  real fixed-output surface, not harmless metadata.
- Linux measurements for durable-workflows root deps converged on one shared
  hash:
  `sha256-bRpUx3CcZvXceoqWDbhaWvScxWtg1sdiOtY7mVKJX70=`.
- Darwin measurement was still pending because the branch path was unavailable
  on the remote host used for delegation.

Conclusion:

- Prepared deps should strip and reject `.bin` by default, then recreate bins
  in the restore/build projection phase.
- This requires a prepared artifact version bump because the recursive output
  hash changes.
- Shared fixed-output hash helpers should require complete measurement metadata
  or an explicit pending-system marker before collapsing per-system hashes.

## Migrated VRS Evidence

The previous dotfiles VRS roots for live node_modules installs, Nix pnpm CLI
prepared dependencies, and dependency materialization profiles were split into
the child systems under this directory. The migration keeps product-owned
contracts in effect-utils and leaves fleet/task orchestration policy outside
this repo.
