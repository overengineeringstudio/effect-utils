# Tui-Core Real Editor Soak

Date: 2026-08-27 — Host: dev3 (x86_64-linux) — Neovim + vtsls — Buck2
2026-08-22.

## Question

Does the scoped Buck-owned tui-core editor view remain usable through a real,
continuously running editor language-service session across dependency removal
and restoration, without restarting the editor/client or issuing
`reloadProjects`?

## Method

A Neovim process was held open in an isolated tmux session on
`tui-core/test/renderer.test.ts`. Its configured vtsls client remained attached
for the entire run. The soak exercised:

1. baseline diagnostics, definition navigation, and completion;
2. Vitest plus Node CJS and ESM resolution through package-local
   `node_modules`;
3. a source TS2322 positive control edited, saved, undone, and saved through
   Neovim itself;
4. removal of `vitest` from tui-core's generated manifest and root lock
   importer, Buck rebuild, staleness check, and atomic editor publication;
5. exact manifest/lock restoration, Buck rebuild, and reverse publication;
6. resolver sampling during the changed view;
7. Vitest execution before/after snapshot hardening, with canonical snapshot
   digests compared around the test run.

The package/lock mutations were temporary and restored byte-for-byte. Publisher
correctness used no sleeps/timeouts; polling intervals were observation only.

## Result

- One vtsls client (`id=2`) remained attached throughout. Baseline diagnostics
  were empty. Definition on `InlineRenderer` resolved to `src/renderer.ts`, and
  completion returned `appendStatic`, `dispose`, and `render`.
- The Neovim-authored positive control produced TS2322 at the saved line and
  cleared after editor undo/write, without client restart.
- Baseline Vitest passed 7/7. CJS `require.resolve("vitest")` and ESM
  `import.meta.resolve("vitest")` both resolved into the current stamped editor
  snapshot.
- Before publishing the dependency removal, the staleness gate failed loudly:
  recorded fingerprint
  `d5d7ed53593fa1bf5eafff0b33e0e01942b6f6de6ca5e4e4203ef1950b55fc6a`,
  current fingerprint
  `05dc0a2874dc684f6f91cdee018d5a3e3e50fb11577b4b35dc6608569a3c7874`.
- After removal publication, the same vtsls client emitted TS2307 for `vitest`.
  Stable `typescript` resolution sampling observed both complete old/new
  snapshot paths and zero failures.
- Exact dependency restoration plus publication initially left vtsls' failed
  lookup diagnostic resident after 45 seconds. An mtime-only touch of the
  stable package manifest cleared it immediately without restart. The
  publisher now performs that content-settle signal after every successful
  flip. A repeated remove/restore cycle then produced TS2307 and cleared it
  automatically with the same client (`id=2`), with no manual touch or reload.
- Real Vitest exposed two mutation paths in writable snapshots: `.vite` and
  `.vite-temp`. Moving the configured Vite cache to ignored `.devenv` removed
  `.vite`; Vite still creates `.vite-temp` under the nearest writable
  `node_modules`. Publishing snapshot directories read-only forced Vite's
  supported fallback beside the package config. Vitest still passed 7/7, no
  snapshot temp paths remained, and the canonical node_modules digest stayed
  `dd86e41a8ab53247bce2656dae44a4d61c57d1f8b33df56acdfca8740f6caa1e`.
- The first-hop symlink and retained legacy install remained intact. Old
  snapshots were retained; no GC claim was made.

## Conclusion

The scoped tui-core editor publisher passes the real-editor gate on Linux:
Neovim/vtsls observes removals and restorations through atomic view flips with
one continuously running client, while navigation, completion, Vitest, CJS,
and ESM resolution remain functional. Two production requirements discovered
by the soak are now part of the mechanism: a package-manifest content-settle
signal after publication, and read-only snapshot directories with consumer
caches redirected outside the immutable view.

This validates the one-package editor mechanism only. Root pnpm-install
deletion remains blocked until every required package/tool consumer has an
admitted publication surface; workspace live-source links require a package
with a real sibling edge.

## VRS Impact

Validates decision 0015's real-editor soak gate for the scoped tui-core surface
and DEPS-R05/R06 on Linux. No requirement change. Snapshot retention/GC and
whole-workspace dependency authority remain later Phase-4 work.
