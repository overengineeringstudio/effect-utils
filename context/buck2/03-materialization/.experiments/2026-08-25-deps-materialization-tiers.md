# Dependency materialization tiers for TypeScript under Buck

Date: 2026-08-25
Host class: x86_64-linux development host (dev3), pnpm 11.8.0, warm ~6.1 GB store

## Question

How should `node_modules` reach Buck actions: exact per-package projection
(tier a), a coarse per-package `pnpm deploy` action (tier b), an impure
boundary that leaves the root install outside Buck (tier c), or
store-as-CAS-input with constructed virtual dirs (tier d)?

## Method

- Tier-a assessment read the shipped code, not its docs:
  `packages/@overeng/buck2-tools/src/pnpm-closure.ts` (1,002 LOC) plus model,
  canonical, tests, genie projection, and the tui-core target — ~2,700 LOC
  total surface.
- Tier-b prototype ran real `pnpm deploy --filter <pkg> --prod=false
--ignore-scripts --offline` from a manifest-only skeleton (lockfile,
  workspace file, root manifest, all 36 workspace `package.json`, the 2 patch
  files — pnpm fails loudly when a referenced patch is missing).
- Determinism was checked by byte-diffing two independent deploy runs.
- Fail-closed behavior was checked against an empty store with `--offline`.
- Functionality was checked by running `tsc --noEmit` against the deployed
  tree with an injected type error as a negative control.

## Result

- Tier a today is selection-only. The emitted artifact
  (`packages/@overeng/tui-core/buck2/typescript-input-plan.json`) is stamped
  `non-authoritative-input-plan` / `"authoritativeCompiler":
"buck-action-required"`; its content digests are stubbed
  (`unverified-plan-only`). No component materializes `node_modules` from it;
  the consuming Buck rule archives evidence tars. Full realization still
  requires per-package fetch/normalize materializers, patch application,
  virtual-store layout mirroring pnpm 11.8 `depPath` internals, `.bin`
  projection, and workspace linking — an estimated 2–3x more code.
- Tier b measured: `@overeng/tui-core` 74 packages, 0.93 s wall / 2.8 s CPU,
  274 MB, ~5,000 files; `@overeng/genie` (328 packages incl. workspace deps)
  2.7 s wall / 6.1 s CPU, 608 MB. `tsc --noEmit` typechecked tui-core for real
  (201 files loaded; injected error caught).
- Tier b determinism: two runs byte-identical except an enumerable impurity
  set — `.bin/*` shims (absolute `NODE_PATH`) and three pnpm metadata files
  (`.modules.yaml`, `.pnpm-workspace-state-v1.json`, pruned lockfile with
  absolute paths). A ~30-line normalization step (delete metadata, rewrite
  shims) makes the tree relocatable; all package-content symlinks are already
  relative, contents are hardlinks from the store.
- Tier b gotchas: genie-generated manifests are mode 444 and `pnpm deploy`
  copies-then-rewrites `package.json`, dying EACCES — staging must install
  manifests writable. Workspace deps are injected as copies with the absolute
  staging path in the virtual-store dir name (fixed later by fixed-path
  staging and the symlink-back fix; see the editor-surface and benchmark
  records). Empty store + `--offline` fails cleanly
  (`ERR_PNPM_NO_OFFLINE_TARBALL`).
- Tier b caching shape: do not remote-cache the 274–608 MB outputs; mark the
  deploy action `local_only` and let downstream typecheck actions be the
  cached ones — their keys hash the deploy output digests. Free upgrade:
  `pnpm deploy` writes a per-package pruned lockfile; a two-stage graph
  (prune keyed on the full lockfile → install keyed on the pruned lockfile)
  recovers most of tier a's fine-grained invalidation with ~0 LOC.
- Tier c is honest only with remote caching disabled for deps-consuming
  actions: an action result keyed on a lockfile hash but computed against a
  drifted ambient install uploads a wrong artifact under an honest-looking
  key and poisons every machine sharing the cache. This repo already has a
  live history of silent install staleness.
- Tier d is the destination tier a fronts; wrong first step (big-bang before
  first value), natural upgrade from tier b behind the same target boundary.

## Conclusion

Adopt tier b for the vertical slice: a per-package Buck action staging the
manifest skeleton and running `pnpm deploy --offline`, plus normalization.
Keep the tier-a closure compiler dormant as the future tier-d front-end; it
does not sit on the critical path. Take the free pruned-lockfile two-stage
upgrade when manifest-change fan-out matters (see decision 0015's gate).
Tier c is a fallback only with remote cache disabled for affected actions.

## VRS Impact

Feeds [decision 0015](../../.decisions/0015-buck-owned-dependency-surface.md)
and grounds DEPS-R01 (manifest-only inputs), DEPS-R02 (fixed-path staging and
normalization), and DEPS-R08 (fail-closed offline). Parks the exact closure
compiler as the dormant future-tier front-end.
