# Production Composition Cutover

Date: 2026-08-28 — Host: dev3 — Linux x86_64 — Buck2 pin 2026-08-22.

## Question

Does the production decision-0020 implementation synthesize a full effect-utils workspace from a fresh store worktree, preserve the reference-only `effect` checkout, run the repository quick gate from the owned-member cwd, and retain one remote-cache namespace across fresh composed workspaces?

## Method

Built the exact `.#megarepo` package from implementation commit `f4ec532b47f6481215dd0b7247bfe887edde13ae` (`/nix/store/4j3qlk6h0h4811ya8nrqvl1ls67579wd-megarepo-with-completions-0.0.0`). Three fresh branchy workspaces (`c41`, `c42`, `c43`) were synthesized with explicit tracking mode and lock-sync disabled.

The first workspace ran dry-run and apply, then checked topology and revision: `repos/effect-utils` was the writable real directory at the exact branch commit; `repos/effect` was the canonical detached reference symlink at locked commit `e5998a45f69960b38eb2b8cb67cbb07b9e6962c7`. `devenv tasks run check:quick --no-tui` ran from `repos/effect-utils`.

The quick gate populated four real tui-core actions. A second workspace explicitly built `dist`, `typecheck`, `node_modules`, and `editor_inputs`, populating the one action not exercised by the quick gate. A third fresh workspace then built the same four targets against the fleet cache. All commands used the composition-published Buck wrapper and canonical `effect_utils//` labels.

The first end-to-end attempt exposed three production-only integration defects that fixture tests had missed: ignored-member dry-run read the future owned lock path; shared mr task checks assumed `repos/` below the member cwd; and the devenv cache hook wrote `.buckconfig.local` into the member instead of the project root. Each source defect was fixed with focused regression coverage before the recorded run.

## Result

- **Production synthesis PASS:** dry-run and apply both succeeded from a fresh store worktree; the workspace root was not a Git worktree; the owned member was the sole writable branch worktree; root Buck authority published last.
- **Reference-only member PASS:** `effect` remained available at its locked detached checkout while absent from Buck cells, capability projection, overlays, and mutation-driven composition work.
- **Repository gate PASS:** `check:quick` exited 0 from the owned-member cwd. mr setup/status/source-policy checks resolved the synthesized project root, formatting and oxlint were clean, and Buck connected to the fleet REAPI endpoint from the project-local config.
- **TierA-scale build PASS:** the full effect-utils source tree ran the real five-action tui-core target tuple in the production composition shape, rather than the fixture graph used by the architecture experiments.
- **Cross-worktree cache PASS:** the final fresh workspace reported `Cache hits: 100%`, `Commands: 5 (cached: 5, remote: 0, local: 0)`, and `BUILD SUCCEEDED`.
- **CI boundary PASS:** independent correctness and security reviews accepted the generated disposable-workspace workflow after full-history fetch, owned-member cwd, guarded cleanup, checkout credential removal, composition-before-credentials ordering, and main-ref-only secret gates.

## Conclusion

The production one-writable-member cutover and tierA-scale Linux gate are complete. The implementation preserves the exact action namespace established by the prototype while replacing its fixture lifecycle with real mr acquisition, publication, task, cache, and recovery paths. The remaining Darwin advance-path gate is independent: it still requires the human Full Disk Access grant tracked by dotfiles issue 2108 before a headless FSEvents receipt can be produced.

## VRS Impact

Discharges the Phase-2 production materialization, canonical-label/standalone-config deletion, cross-member dist-overlay, CI-workspace, tierA-scale Linux, and shared-cache obligations in the roadmap. Decision 0020 remains unchanged. Darwin FSEvents invalidation remains explicitly open; the APFS copy/exchange/R6 primitive evidence in `2026-08-27-macos-apfs-primitives.md` is not overstated as that missing runtime receipt.
