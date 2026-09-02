# Minimal Buck2 tsgo typecheck rule over a real package

Date: 2026-08-25
Host class: x86_64-linux development host (dev3), Buck2 `2026-04-14-7600cb80`

## Question

Can a minimal Buck2-owned TypeScript typecheck of a real package (tui-core)
work with low rule complexity, and where on the pain scale does the
node_modules-as-action-input cost land?

## Method

- Real package, no reduction: `@overeng/tui-core` (6 TS files, ~1.1k LOC, no
  workspace sibling deps), checked with `effect-tsgo` from the devenv profile.
- Baseline measured by direct tsgo invocation on a copy of the package.
- Correctness proven both ways: injected TS2322 → exit 2 with the diagnostic;
  unrelated-file touch → no re-run; `.d.ts` edit inside node_modules → re-run.
- The dependency closure (59 packages, ~104 MB) was materialized exactly from
  the committed genie artifact
  `packages/@overeng/tui-core/buck2/typescript-input-plan.json`, which proved
  to be a correct and sufficient closure description.

## Result

| Probe                                             | Observation                                                                               |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Direct tsgo baseline                              | cold 91 ms, `--force` 61 ms, no-op 9 ms                                                   |
| Buck2 rule (~40 lines, `ctx.actions.run` staging) | first-ever build incl. fresh daemon 0.58 s                                                |
| Source-edit re-run                                | 123 ms                                                                                    |
| Warm no-op                                        | 14 ms                                                                                     |
| `.d.ts` edit inside 104 MB closure                | re-run in 75 ms (watchman reports the one file; the closure is never re-hashed wholesale) |
| Buck2 overhead over raw tsgo                      | ~20–60 ms per action                                                                      |

node_modules input tiers:

1. pnpm symlink forest as tracked input: fails out of the box — Buck2 errors on
   DANGLING symlinks, which the real store authentically contains (pnpm alias
   links for platform-excluded optional deps: `fsevents`, `@esbuild/darwin-*`,
   `lightningcss-*`). After pruning dangling links only, the forest works
   (cold 0.17 s, no-op 14 ms). A production rule needs a pruning step or a
   genie-emitted pruned tree.
2. Pruned flat dereferenced closure (59 dirs, 104 MB): best tier; numbers above.
3. node_modules outside the inputs (impure): works and is fastest to set up,
   but a broken `.d.ts` in the external tree produced a silent stale PASS —
   the disqualifying failure mode.

Local cache boundary: Buck2's local action cache is in-memory. After
`buck2 kill`, a no-op rebuild re-executed the action (1.27 s incl. daemon
start). Cross-daemon/cross-machine no-ops therefore require the shared remote
cache; the two efforts compose.

What the prototype faked (production needs): a toolchain target carrying a
`/nix/store` tsgo path (the prototype passed an absolute per-worktree
`.devenv` path as a string — untracked, and per-worktree paths split cache
keys); genie-emitted closure materialization from the input plan; workspace
sibling deps as inputs for the other ~35 packages (the real granularity
question); a decision on emitting `dist/` as the action output vs a slim
verdict artifact for cache-upload economics.

Scale note: 59-pkg/104 MB closure hashed and built in 0.58 s cold; Effect-heavy
packages with several-hundred-MB closures extrapolate to a few seconds of
one-time hashing, amortized by watchman. Nothing suggests per-package coarse
granularity is other than comfortably viable.

## Conclusion

A production TS check rule is viable at low complexity (System
Initiative-style coarse per-package granularity). The node_modules input cost
is near-negligible at this closure size — not rules_js-grade pain. Feeds the
Phase 1 vertical slice and the 02-execution TypeScript spec; the dependency
materialization mechanism itself is owned by 03-materialization.

## VRS Impact

Validates the [02-execution](../spec.md) TypeScript action shape and grounds
EXEC-R02 (store-path toolchains: per-worktree tool paths appear verbatim in
argv and would split keys) and DEPS-R02's dangling-symlink pruning (pnpm's
platform-excluded optional-dep aliases are fatal to Buck input tracking).
