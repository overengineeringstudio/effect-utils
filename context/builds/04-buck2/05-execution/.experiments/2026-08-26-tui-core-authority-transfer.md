# Tui-Core Authority Transfer: Integrated BUCK-R12 Gate

Date: 2026-08-26 — Host: dev3 (x86_64-linux) — Buck2 2026-04-15 —
commit `669792253b200fa7bb40b61b62a2ef9bd121b4c0`.

## Question

Does the integrated tui-core vertical slice satisfy BUCK-R06/R09/R12 and
EXEC-R10 after deleting the legacy root-solution producer: exact type failure,
relevant/irrelevant invalidation causality, hostile-environment hermeticity,
strict-surface delegation, and zero re-execution in a fresh same-platform
context?

## Method

The admitted tuple was built through these stable labels:

- `//packages/@overeng/tui-core:node_modules`
- `//packages/@overeng/tui-core:package_tree`
- `//packages/@overeng/tui-core:typecheck`
- `//packages/@overeng/tui-core:dist`

The final mechanism is a two-stage pnpm prune/install action keyed through a
canonical install-descriptor artifact, a contained package-tree action, and
hermetic TypeScript actions whose argv carries pinned Nix Bun, the declared
runner artifact, and pinned effect-tsgo. All execute locally but permit cache
upload after the confirmed decision-0015 Amendment 2 portability proof.

Controls were run in an isolated branchy worktree and restored after every
mutation:

1. baseline and immediate unchanged rebuild;
2. representative source type error;
3. declaration-affecting source mutation and exact restoration;
4. unrelated root README mutation;
5. fresh Buck isolation under `env -i`, poisoned ambient tool variables, and a
   PATH where `sh`/`rm`/`cp`/`mv`/`chmod`/`mkdir` pointed to `/bin/false`;
6. `aquery` of execution/cache policy and pinned argv;
7. fleet-cache populate in context A, then killed/wiped context B at the exact
   revision;
8. `devenv tasks run ts:check:strict`, whose graph materializes Buck `dist`
   before checking the 38-project solution.

## Result

- Baseline all-four build `c05f0beb-b9ac-4b3b-8aad-8400e86bb854` executed
  exactly `pnpm_pruned_lock`, `pnpm_node_modules`, `package_tree`,
  `tsgo_typecheck`, and `tsgo_emit`. Immediate build
  `983899f8-bdd1-4cf1-8f3e-d96b98ca6e3c` executed zero actions.
- Injected `const ...: string = 42` failed `:typecheck` with TS2322; exactly
  `package_tree` and `tsgo_typecheck` ran.
- Changing `Color256.ansi256` from `number` to `number | `${number}``changed`dist/src/ansi.d.ts`from`d6dbc0bf8ea13b49b484aa0070403aeecfcb3baa8ffba927cdddf815fcf192ce`(4350 bytes) to`338a9e3d78bc174c41388cfd79a482779101825c49ca3f4ccaf3752172c0fa94`
  (4364 bytes); restoration returned the original digest exactly.
- The unrelated README mutation executed zero actions and left the declaration
  digest unchanged.
- The hostile-environment build succeeded, then its unchanged rebuild executed
  zero actions. Action argv named immutable Bun, pnpm, and effect-tsgo paths;
  no poisoned ambient command was used.
- `aquery` reported `LocalRequired` plus `allow_cache_upload = true` for prune,
  install, and package-tree actions.
- Fleet cache: context A populated the final tuple; fresh context B after daemon
  kill and `buck-out` wipe reported `Cache hits: 100%`,
  `Commands: 5 (cached: 5, remote: 0, local: 0)` (build
  `1aea64ad-28cb-44bc-bb5f-eca68cb975a6`).
- `ts:check:strict` passed after its required Buck materialization dependency.
- `devenv tasks run check:quick`, focused strict package TypeScript, 19
  materializer tests, generated-file freshness, lint, and strict VRS checks all
  passed. Final mutation worktree was clean and Buck daemons were stopped.

## Conclusion

The tui-core authority transfer passes the full integrated BUCK-R12/EXEC-R10
gate. Buck is the only normal check/emit producer for tui-core: both root
solutions exclude only that tagged project; every supported `ts:check` surface
materializes fresh Buck declarations first. BUCK-R06 holds literally for the
entire admitted tuple in a fresh same-platform context, including both
materialization actions.

The missing/stale-dist prototype demonstrated why task ordering is load-bearing:
TypeScript falls back to source when `types` output is absent and can consume
stale declarations when present. The admitted task graph closes that gap; direct
out-of-contract compiler invocation remains unsupported.

## VRS Impact

Validates BUCK-R06/R09/R12, EXEC-R10, DEPS-R02/R07/R08, decision 0015
Amendment 2, and roadmap Phase 1's tui-core transfer/deletion-ledger milestone.
No requirement change. Phase 2 may proceed; future package admissions repeat
this exact transfer matrix at their authority boundary.
