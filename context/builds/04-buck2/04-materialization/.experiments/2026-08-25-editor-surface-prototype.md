# Buck-owned editor surface prototype

Date: 2026-08-25
Host class: x86_64-linux development host (dev3), buck2 pin 2026-04-14, pnpm 11.8.0

## Question

Can Buck own the editor/dev-loop `node_modules` surface — eliminating the
hand-run root `pnpm install` entirely — with DX that survives real tsserver,
node, and vitest use?

## Method

- Ecosystem research preceded the build: aspect rules_js never puts
  `node_modules` in the source tree; its documented IDE story is a second,
  independent `pnpm install` with accepted drift, and the maintainer's own fix
  proposal (aspect-build/rules_js#854, filed 2023-02-07) is open with zero
  comments. Buck2's bundled prelude has no JS dependency story at all (no
  install rule, no node toolchain); the only found production implementation
  is systeminit/si `prelude-si/pnpm.bzl` (per-package installs, `local_only`).
- The prototype used a real package (tui-core copy), a real
  `pnpm_node_modules` Buck rule, and drove a real tsserver over stdin
  (`tsserver-probe`) with positive and negative controls (a local TS2322 the
  probe demonstrably reports; injected TS2307 for missing modules).
- The dangling-window measurement polled resolution every 50 ms across a
  rebuild (naive flip: 8 OK / 56 BROKEN / 11 OK samples).
- Determinism was verified across three rebuilds after the fix.

## Result

- Enabling fact: `pnpm deploy` is the only pnpm mode emitting
  internal-relative symlinks (`typescript -> .pnpm/...`); a normal workspace
  install emits links that escape upward (`../../../../node_modules/.pnpm`)
  and is not relocatable into `buck-out`.
- Editor wiring that works: a two-hop indirection —
  `<pkg>/node_modules -> ../../.editor-view/<cell>/node_modules` (stable,
  committable) and `.editor-view/<cell> -> .editor-view/.store/<cell>-<nanos>`
  flipped by `rename(2)`. Pointing straight at `buck-out` leaves a measured
  3.06 s window with no `node_modules` (buck2 deletes an action's output dir
  before re-running). Fix: `cp -al` snapshot out of `buck-out` (0.23 s for a
  274 MB / 76-entry tree) then atomic rename — 71/71 samples resolved.
- Resolution gates all passed through the flipped view: tsgo typecheck (251
  files; both negative controls fire), node CJS `require.resolve` and ESM
  dynamic import, vitest 7/7.
- Live tsserver across a dependency flip: removals surface within 3 s with no
  restart; additions initially required `reloadProjects` (failed-lookup
  watchers hold the old snapshot's realpath). The symlink-back fix for
  workspace siblings (benchmark record) removes the remaining restart case.
- Nondeterminism found and fixed: staging in `mktemp -d` baked the absolute
  staging path into virtual-store keys for `workspace:` deps, producing a
  different tree every rebuild; fixed-path staging (`$out.stage`) made three
  consecutive rebuilds byte-stable.
- Latency: full dep-removal loop (manifest+lockfile edit → usable editor
  surface) 4.1 s; one lockfile edit fanning out to 5 cells (two heavy) 7.0 s
  parallel on 32 cores; comparison point: one root `pnpm install` of the whole
  workspace from a warm store is ~15.8 s.
- Disk: six deploy trees whose sizes sum to 2,267 MB occupy 660 MB together —
  contents are hardlinks into the shared pnpm store (verified shared inode,
  nlink 197); marginal cost per tree is directory entries (~4–15 MB).
- In this repository the root install's only job is the symlink forest: root
  `node_modules` contains no top-level packages and no `.bin`; all tools come
  from Nix. The surface Buck replaces is small and mechanical.

## Conclusion

Viable with caveats, adopted as the end-state mechanism by decision 0015 with
a gated cutover. Standing constraints: materialization actions are
`local_only` (pnpm virtual-store keys embed absolute checkout paths, so trees
are not portable across machines); store wiring must use `--store-dir`
explicitly (`PNPM_STORE_DIR` is silently ignored); `.modules.yaml` `prunedAt`
is stripped during normalization.

## VRS Impact

Feeds [decision 0015](../../.decisions/0015-buck-owned-dependency-surface.md)
and grounds DEPS-R05 (atomic editor views: two-hop link, snapshot flip, no
dangling window, live tsserver survival) and DEPS-T01 (local-only trees from
absolute virtual-store keys).
