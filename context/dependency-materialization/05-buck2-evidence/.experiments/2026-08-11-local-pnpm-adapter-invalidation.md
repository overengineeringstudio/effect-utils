# 2026-08-11 Local pnpm Adapter Invalidation

## Question

Can a fine-grained Buck2 TypeScript-check action safely consume the current
live pnpm projection through an ambient local symlink while still providing
correct content invalidation?

## Method

- Ran at Git commit `a155f7554def68e0862f2942f10525a53f226f21` on a shared Linux development host
  with Buck2 `2026-04-14-7600cb8`, Nix-provided `tsgo`, and the current
  devenv/pnpm materialization.
- Created a disposable root Buck cell using the bundled Prelude and one
  `genrule` for `packages/@overeng/tui-core`.
- Declared the package TypeScript sources, tests, package manifest, generated
  tsconfig, and root pnpm lockfile as action inputs.
- First ran the action without a dependency projection, then linked the live
  package-local `node_modules` projection into the staged action root. Remote
  cache and remote execution remained disabled.
- Compared warm no-op runs, an mtime-only source change, a source-content
  comment change, and the same content change after restarting the Buck daemon.
- Timings used Bash `time` on a shared 32-thread host. The host had concurrent
  workload contention and uncontrolled warm filesystem caches, so the
  measurements characterize this run only.

## Result

- A direct staged action without `node_modules` failed correctly because
  `tsgo` could not resolve the Node type definition. This demonstrated that
  Buck's staged action root did not accidentally inherit the live dependency
  tree.
- Linking the live package-local pnpm projection made the action pass. With a
  warm daemon, the first successful action completed in `0.604s` through
  `nix shell`; direct Buck client no-op runs completed in `0.010-0.012s`.
- An mtime-only change correctly caused no action execution and completed in
  `0.011s`.
- After a real content change to the declared `src/mod.ts` input, Buck reported
  the changed inode through a nested `node_modules` symlink alias, completed in
  `0.012s`, and `buck2 log what-ran` reported no action. This was a false cache
  hit because ordinary Buck action keys are content-sensitive and the action
  had not re-executed.
- After killing and restarting the daemon without changing the edited source,
  Buck executed the action once with zero cache hits and passed. The total
  restart-plus-build time was `71.359s`; startup was host-contaminated and is
  not a steady-state performance claim.
- Existing-path context was materially different from compiler cost:
  `devenv tasks run ts:check --mode single` took `16.700s` and `16.723s` on two
  warm samples, while direct whole-workspace `tsgo --build` no-op samples took
  `0.235-0.280s`. A first end-user task path took `104.332s` while realizing and
  evaluating additional Nix/devenv state.

## Conclusion

The ambient pnpm-symlink adapter is rejected as an authority-grade action and
must not upload to a shared or remote cache. It can produce stale success within
a live daemon after a declared source changes. The experiment supports
fine-grained generated targets only when their dependency inputs are staged as
an immutable declared artifact, or when an alternative dependency model proves
equivalent invalidation with RED/GREEN controls.

The timing also shows that the current devenv task facade has substantial warm
orchestration overhead relative to the underlying no-op compiler and a warm
Buck daemon. Future benchmarks must report the end-user path and compute-only
path separately.

## VRS Impact

- Supports DMP.BUCK-R01 and DMP.BUCK-R04: ambient live pnpm state is not a safe
  declared Buck input and Buck must not silently own live materialization.
- Narrows DMP.BUCK-R05: the next prototype must use an immutable dependency
  artifact or another explicit dependency projection and prove content-change,
  lockfile-change, and cross-worktree invalidation before remote caching.
