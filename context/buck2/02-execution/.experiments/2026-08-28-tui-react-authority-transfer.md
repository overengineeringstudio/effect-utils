# tui-react Authority Transfer

Date: 2026-08-28 — Linux x86_64 — Buck2 pin 2026-08-22.

## Question

Can `@overeng/tui-react`, the first admitted package with workspace dependencies and surviving root project-reference consumers, transfer typecheck and declaration emit exclusively to Buck while preserving dependent checks, precise invalidation, and cross-worktree cache reuse?

## Method

Added reusable generated package targets for dependency materialization, package-tree assembly, typecheck, emit, and editor inputs. tui-core enters through its Buck `dist`; utils and utils-dev enter as exact content-tracked source siblings (83 and 25 files) whose external modules come from tui-react's package-local materialization. The frozen pnpm replay was exercised with pinned pnpm 11.8.0 and a warm store; this exposed and fixed package-boundary manifest labels, relative workspace-directory canonicalization, nested install layout, manifest plus lockfile rehydration, and missing implementation inputs in action keys.

The six dependent project-reference edges were removed, the ordinary tui-react tsconfig made write-free, both root solutions regenerated without tui-react, and the generic publication task materialized both admitted dist targets. The root check ran with the pinned tsgo after publication; root emit ran between SHA-256 observations of `tui-react/dist/src/mod.d.ts`.

The BUCK-R12 slice used fresh synthesized workspaces. A deliberate `string`-to-`number` error in `src/mod.tsx` exercised relevant invalidation, then the source was restored. A root changelog edit exercised irrelevant invalidation. A fresh workspace with no pnpm store exercised the populated remote cache, followed by an empty writable environment (`env -i`, writable HOME, minimal system PATH).

## Result

- **Target suite PASS:** `dist`, `typecheck`, and `editor_inputs` build successfully; the no-op repeat executes zero actions.
- **Workspace replay PASS:** frozen pnpm install succeeds with directory dependencies, then removes transient workspace links before contained-link normalization. Twelve focused descriptor/materializer tests pass.
- **Exclusive authority PASS:** no `../tui-react` project references remain; tui-react is absent from `tsconfig.check.json` and `tsconfig.emit.json`; its ordinary tsconfig has `noEmit: true`. Root typecheck passes through package export declarations. Root emit leaves the Buck declaration checksum unchanged (`d48b6f…d502` before and after).
- **Relevant mutation PASS:** Buck reports TS2322 at `src/mod.tsx`; restoring the source returns `Cache hits: 100%`, `cached: 2`, `local: 0`.
- **Irrelevant mutation PASS:** changing `CHANGELOG.md` executes zero actions and succeeds in 0.46 s.
- **Cross-worktree cache PASS:** a fresh synthesized workspace with no local pnpm store reports `Cache hits: 100%`, `Commands: 9 (cached: 9, remote: 0, local: 0)`, `BUILD SUCCEEDED` in 7.07 s.
- **Hostile environment PASS:** with an otherwise empty environment and fresh writable HOME, the target reports `Cache hits: 100%`, `Commands: 8 (cached: 8, remote: 0, local: 0)`.
- **Independent review PASS:** the final review verified generated/source parity, all Buck labels, source censuses, external source-sibling imports, frozen replay, root producer deletion, and two-package dist publication.

## Conclusion

Admission 2 is complete. The materialization boundary now handles real workspace dependencies without ambient source or install state, and tui-react has one typecheck/emit producer. The fresh-context result remains far below the three-minute budget and executes zero local actions once populated.

## VRS Impact

Discharges the second Phase-3 deletion-ledger entry in the roadmap and establishes the reusable source-sibling plus dist-sibling pattern for later TypeScript admissions. The transitional editor root install remains intentionally outside this transfer and is still deleted only at the Phase-4 dependency-surface gate.
