# Utils TypeScript Authority Transfer

Status: accepted
Date: 2026-09-02

## Question

Can `@overeng/utils` transfer exclusive TypeScript typecheck and declaration authority to Buck while its dependents consume only the emitted declarations and the admission budgets remain satisfied?

## Method

The package-local `BUCK.genie.ts` declaration gained authority metadata. All 13 public TypeScript export conditions now resolve to Buck-emitted declarations while runtime defaults remain at source, and the ordinary tsconfig is write-free. The generated member manifest publishes the utils dist overlay. Both root TypeScript solutions and 16 dependent project-reference edges were regenerated after deleting utils from their source projects. tui-react's Buck package tree now consumes utils through `//packages/@overeng/utils:dist` instead of a content-tracked source sibling.

The utils `typecheck` and `dist` targets were built together. A deliberate `number`-to-`string` error was injected into `src/isomorphic/string.ts`, then restored. A changelog-only mutation exercised irrelevant invalidation. A fresh warm-cache context stopped the daemon, removed the composition root's generated Buck state, regenerated it, and rebuilt both targets. A final run used an otherwise empty environment with a fresh writable HOME and a minimal system/devenv PATH.

## Result

- **Target suite PASS:** the initial two-target build completed in 1m51s. Every one of the 13 public type export paths exists inside the emitted dist, including `src/node/storybook/config/mod.d.ts`, which consumes stylex-preset's copied handwritten Vite declaration.
- **Relevant mutation PASS:** Buck reported TS2322 in `src/isomorphic/string.ts`; restoring the source returned the target to green with both actions served from cache and zero local execution.
- **Irrelevant mutation PASS:** changing only `CHANGELOG.md` left the analyzed target at zero executed actions and zero network traffic.
- **Fresh warm-cache context PASS:** 271/271 commands were cache hits, zero commands executed locally, and the Buck build completed in 12.6s.
- **Hostile environment PASS:** with an empty environment, fresh writable HOME, and minimal PATH, 271/271 commands were cache hits, zero commands executed locally, and the build completed in 8.1s.
- **Buck target gate PASS:** `CI=1 devenv tasks run buck2:check --no-tui` completed successfully in 1m40s with all authoritative typecheck targets.
- **Integrated bridge PASS:** `CI=1 devenv tasks run check:quick --no-tui` completed successfully in 1m12s; its dependency graph materialized all authoritative declarations before the surviving root TypeScript check.
- **Generated and Nix authority PASS:** Genie regenerated the authority surfaces and Evergreen refreshed the six affected root-workspace pnpm fixed-output hashes.

### Deletion ledger — `@overeng/utils`

- Removed utils from both generated root TypeScript solutions.
- Deleted 16 dependent project-reference edges.
- Replaced tui-react's content-tracked utils source sibling with its Buck `dist` edge.
- Pointed all 13 public TypeScript export conditions at `dist/src/**/*.d.ts` and made the ordinary tsconfig write-free.
- No package-local standalone check/build task existed to delete. Buck is now the repository typecheck and declaration producer for utils.

## Conclusion

Utils satisfies exclusive TypeScript authority and the admission budgets. Its dependency layer is independently reviewable and retains its own failure control and deletion ledger.

## VRS Impact

Discharges the next Phase-3 package admission under the dependency-layer PR strategy. BUCK-R06, BUCK-R07, BUCK-R09, BUCK-R12, and BUCK-R16 are re-evidenced for the transfer. No requirement change is needed.
