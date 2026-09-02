# Middle-Layer TypeScript Authority Transfer

Date: 2026-09-02 — Linux x86_64 — Buck2 pin 2026-08-22.

## Question

Can `@overeng/content-address`, `@overeng/effect-distributed-lock`, and `@overeng/otel-contract` transfer TypeScript typecheck and declaration emit to Buck in one dependency-closed layer while retaining package-specific failure controls and deletion-ledger entries?

## Method

Each package-local admission gained authority metadata, dist-backed type export conditions, and a write-free ordinary tsconfig. The package trees consume already-authoritative workspace packages through same-cell Buck `dist` targets: content-address and effect-distributed-lock consume utils-dev, while otel-contract consumes content-address and utils-dev. Generated root/member projections and all affected dependent configs were regenerated after deleting the legacy project-reference edges.

The six package targets (`typecheck` and `dist` for each package) were built together and repeated unchanged. Deliberate `number`-to-`string` errors were injected into each package's `src/mod.ts`; otel-contract was probed separately after restoring its upstream content-address dependency so its own typecheck action could execute. A changelog-only mutation exercised irrelevant invalidation. A fresh warm-cache run stopped the daemon and removed the composition root's generated Buck state. The hostile-environment run used an empty environment, fresh writable HOME, and minimal system/devenv PATH. `buck2:check` exercised the authoritative target gate, and `check:quick` exercised declaration publication before the surviving root TypeScript check.

## Result

- **Target suite PASS:** all six targets built successfully. content-address and effect-distributed-lock emitted `src/mod.d.ts`; otel-contract emitted `src/mod.d.ts` and `src/registry.d.ts`.
- **Warm no-op PASS:** the unchanged six-target repeat completed in 1.2 s with no executed actions.
- **Fresh warm-cache context PASS:** 105/105 commands were cache hits, zero commands executed locally, and the Buck build completed in 2.5 s.
- **Hostile environment PASS:** 105/105 commands were cache hits, zero commands executed locally, and the build completed in 1.9 s.
- **Relevant mutation — content-address PASS:** Buck reported TS2322 in `src/mod.ts` for both its typecheck and declaration emit.
- **Relevant mutation — effect-distributed-lock PASS:** Buck reported TS2322 in `src/mod.ts` for its typecheck.
- **Relevant mutation — otel-contract PASS:** after restoring content-address, Buck reported TS2322 in otel-contract's `src/mod.ts`.
- **Irrelevant mutation PASS:** a `CHANGELOG.md`-only change completed in 0.25 s with no commands or network traffic.
- **Buck target gate PASS:** `CI=1 devenv tasks run buck2:check --no-tui` completed successfully in 3m26s.
- **Integrated bridge PASS:** `CI=1 devenv tasks run check:quick --no-tui`
  completed successfully in 1m33s, including authoritative declaration
  publication before the surviving root TypeScript check.
- **Generated and Nix authority PASS:** the generated projections were fresh after Evergreen refreshed the seven affected root-workspace pnpm FOD hashes.

### Deletion ledger — `@overeng/content-address`

- Removed content-address from both generated root TypeScript solutions.
- Deleted four dependent project-reference edges, including otel-contract's package-local edge.
- Pointed the public type condition at `dist/src/mod.d.ts`, kept the runtime default at source, and made the ordinary tsconfig write-free.
- No package-local standalone check/build task existed to delete.

### Deletion ledger — `@overeng/effect-distributed-lock`

- Removed effect-distributed-lock from both generated root TypeScript solutions.
- Deleted its dependent project-reference edge from utils.
- Replaced its utils-dev source sibling with the authoritative Buck `dist` edge.
- Pointed the public type condition at `dist/src/mod.d.ts`, kept the runtime default at source, and made the ordinary tsconfig write-free.
- No package-local standalone check/build task existed to delete.

### Deletion ledger — `@overeng/otel-contract`

- Removed otel-contract from both generated root TypeScript solutions.
- Deleted 12 dependent project-reference edges.
- Replaced content-address and utils-dev source siblings with authoritative Buck `dist` edges.
- Pointed both public TypeScript export conditions at their `dist/src/*.d.ts` files, kept runtime defaults at source, and made the ordinary tsconfig write-free.
- No package-local standalone check/build task existed to delete.

## Conclusion

The middle dependency layer satisfies exclusive TypeScript authority, precise invalidation, cache reuse, hostile-environment execution, and the admission budgets for all three packages. The final package in this stack can consume this layer only through Buck declarations.

## VRS Impact

Discharges three further Phase-3 package admissions under the dependency-layer PR strategy. BUCK-R06, BUCK-R07, BUCK-R09, BUCK-R12, and BUCK-R16 are re-evidenced for each transfer. No requirement change is needed.
