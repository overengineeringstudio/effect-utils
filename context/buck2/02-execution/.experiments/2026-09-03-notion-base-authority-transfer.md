# Notion Base TypeScript Authority Transfer

Status: accepted
Date: 2026-09-03

## Question

Can `@overeng/notion-core`, `@overeng/notion-effect-schema`,
`@overeng/notion-property-write`, and `@overeng/notion-effect-client` transfer
TypeScript typecheck and declaration-emit authority to Buck as one
dependency-closed base layer, leaving the top layer
(`notion-md`, `notion-react`, `notion-datasource-sync`, `notion-cli`) for the
stacked follow-up that owns those packages?

## Method

Each base package-local `BUCK.genie.ts` admission gained authority metadata
(`projectFile: 'tsconfig.json'`, `declarationEntrypoint: 'src/mod.d.ts'`).
Intra-base workspace siblings now consume same-cell Buck `dist` targets instead
of content-tracked sources: effect-schema consumes notion-core, property-write
consumes notion-effect-schema, and effect-client consumes notion-core plus
notion-effect-schema. Root check/emit solutions, the member-manifest dist
overlays, and the per-package `dist` entrypoint assertions regenerated from the
same admissions via `devenv tasks run genie:run`.

Entrypoint verification (no guessing): every base package exposes a single
public `.` export resolving to `./src/mod.ts` (read from each
`package.json.genie.ts` `exports` block), each `src/mod.ts` exists on disk, each
package tsconfig is composite with `rootDir: '.'` / `outDir: './dist'` (shared
`packageTsconfigCompilerOptions`), so the Buck emit produces
`dist/src/mod.d.ts` — the same shape as the already-authoritative
single-export packages (`content-address`, `effect-distributed-lock`,
`otel-contract`, `tui-core`), which all assert `src/mod.d.ts`. The
`./test` subpath of notion-effect-client is `published: false` and needs no
dist types condition.

## Result

- **Regen PASS:** `genie:run` touched exactly the expected files — 4
  `BUCK.genie.ts` sources, 4 regenerated `BUCK` projections
  (`declaration_entrypoint` + sibling source-to-`dist` swaps), `buck2-member.json`
  (+4 dist overlays), `tsconfig.check.json` and `tsconfig.emit.json` (31→27
  refs each). No unrelated drift, no editor-view changes.
- **Freshness PASS:** `devenv tasks run genie:check --no-tui` exits 0.
- **Unit PASS:** `devenv tasks run genie:buck2:test --no-tui` — 25 pass, 0 fail
  across 5 files; both authority unit tests derive expectations dynamically, so
  no test-expectation updates were required.
- **Buck target gate DEFERRED to CI:** per the transfer plan, no local
  `check:all`; CI `buck2:check` proves the four new `typecheck` targets and
  `check:quick` proves declaration publication before the surviving root check.

### Deletion ledger — notion base layer

- Removed all 4 base packages from both generated root TypeScript solutions
  (31→27 refs each).
- Published 4 member-manifest dist overlays (`:dist` → `<package>/dist`).
- Replaced 4 intra-base content-tracked source siblings with Buck `dist` edges
  in the generated package trees.
- Deleted 16 dependent project-reference edges: 4 intra-base (schema→core,
  property-write→schema, effect-client→core+schema) plus 12 top→base edges in
  the 4 top packages' `tsconfig.json.genie.ts` (md 4, react 2, ds-sync 4,
  cli 2). The deletions are REQUIRED in this commit, not cosmetic: a package
  with `noEmit: true` may not be project-referenced, so every surviving edge
  fails both `tsgo_emit` (`TS6053`, proven red in CI) and oxlint
  (`typescript(tsconfig-error)`, proven red in CI). All 16 targets are declared
  workspace deps, so `tsc` keeps resolving via `node_modules`; companion
  changes are deletion-only per the #1193 precedent.
- Set `noEmit: true` on all 4 base tsconfigs (Buck is the sole dist producer).
- Remaining debt (top-transfer scope): 4 intra-top edges, cli→effect-path
  (target not yet authoritative), dist-backed `types` conditions.

## Conclusion

The notion base layer satisfies Buck-first TypeScript authority admission:
root solutions no longer list the base packages, their `dist` overlays are
published, their package trees consume each other through Buck
declarations, and all 16 project-reference edges into noEmit packages are
deleted. Exclusive sole-producer status completes with the top-layer
transfer (remaining intra-top edges, cli→effect-path, dist-backed type
conditions), which is unblocked by this commit.

## VRS Impact

Discharges the base half of the notion projection-chain authority transfer
(base #1204, stacked under top #1205). BUCK-R06, BUCK-R07, BUCK-R09, BUCK-R12,
and BUCK-R16 are re-evidenced for the admission. No requirement change is
needed; the 16-edge deletion ledger item is tracked as top-transfer scope.
