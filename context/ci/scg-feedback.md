# SCG source feedback without devenv

From the checkout root, with the pinned Bun, effect-tsgo and oxlint toolchain
already on `PATH` and package dependencies prepared:

```sh
bash scripts/package-feedback.sh packages/@overeng/scg-protocol
bash scripts/package-feedback.sh packages/@overeng/scg-authority
bash scripts/package-feedback.sh packages/@overeng/scg-discord
```

Each command checks the existing oxlint configuration, runs incremental
`tsgo --build`, then runs the complete package Vitest inventory under Bun.
No shell realization, Nix evaluation, secret provider or devenv invocation occurs.
The SQLite, child-process and socket-lifecycle integration tests are included;
this is not a live-service deployment or an external-system acceptance proof.

Use the repo's Buck-published dependency view/toolchain for normal development.
For this isolated bakeoff, dependencies were prepared using
`pnpm --filter '@overeng/scg-*...' --filter '@overeng/oxc-config...' install --frozen-lockfile --ignore-scripts`.
This took 2.60 seconds with an already populated pnpm store. The lint plugin's
own dependencies are essential: selecting only the SCG packages made lint fail
before checking files. The script intentionally does not install or fetch tools.

This is source feedback, **not merge evidence**: Buck remains the authoritative
checker and producer. Run the prescribed exact-head `check:quick` before queue
admission. Incremental TypeScript state can miss dependency-tree changes; after
changing dependencies, republish the owned view and use the authoritative gate.
Do not interpret an unchanged incremental build as a fresh hermetic check.

## Bakeoff, 2026-11-19

Wall seconds on Apple Silicon, Bun 1.4.4, pnpm 12.17.0, Vitest 5.0.3,
effect-tsgo 0.14.5. Each cell is first invocation / immediate repeat, two
observations per candidate/package, not a statistical latency estimate.
The first tsgo invocation had no package build-info; subsequent commands reused
it. Dependency archives were warm throughout; “first” is **not** a cold machine
or cold Nix closure. Concurrent host activity produced visible variance.

| Candidate | protocol | authority | discord | Failed runs / total |
| --- | ---: | ---: | ---: | ---: |
| Full Vitest under Bun | 1.977 / 2.253 | 3.062 / 2.130 | 5.611 / 7.252 | 0 / 6 |
| Plain `bun test` | 1.189 / 1.697 | 1.029 / 1.203 | 10.869 / 7.615 | 4 / 6 |
| Plain pnpm/Node Vitest | 2.327 / 1.442 | 1.251 / 1.301 | 2.616 / 3.162 | 4 / 6 |
| Bun Vitest, one worker | 1.370 / 1.849 | 3.421 / 1.683 | 7.457 / 7.934 | 0 / 6 |
| Bun Vitest `--changed=HEAD~1` | 2.341 / 1.710 | 1.617 / 2.017 | 5.877 / 5.109 | 0 / 6, but first two packages selected zero tests |
| `tsgo --build` | 0.830 / 0.033 | 0.725 / 0.043 | 2.010 / 0.114 | 0 / 6 |
| oxlint, plugin dependencies prepared | 1.027 / 0.963 | 1.026 / 0.910 | 1.029 / 1.234 | 0 / 6 |
| Shipped complete command, build-info already warm | 4.101 / 4.774 | 5.169 / 5.986 | 12.139 / 14.801 | 0 / 6 |

The warm incremental typecheck was 25.2x / 16.9x / 17.6x faster than its first
invocation. Keep full Bun-hosted Vitest: Node cannot execute the Bun SQLite and
process fixtures; bun test fails existing Vitest collector integration; changed
selection can skip the entire package. One worker did not improve the largest
suite. Although protocol alone is faster with bun test, sharing the existing
Vitest runner avoids a package-specific runner convention for a small saving.
No direct devenv-task run was performed: this machine's no-Nix-evaluation rule
precludes realizing an uncached task shell. CI provides the observed baseline.

## CI preparation: coordinate through #2605

| Preparation lane | Observed wall seconds | Outcome |
| --- | ---: | --- |
| Cold whole-devenv preparation, two independent runners | 1573, 1572 | 2 / 2 timed out before editor bootstrap |
| Retry of the first job | 961 | Prep passed; later quality failed |
| Pinned minimal `nix develop` closure | Not measured | Proposed replacement, not a demonstrated speedup |
| Protected-published cached minimal toolchain closure | Not measured | Preferred experiment, not yet CI rollout evidence |

Receipts: [first cold timeout](https://github.com/overengineeringstudio/effect-utils/actions/runs/44336501265/job/134914631385),
[second cold timeout](https://github.com/overengineeringstudio/effect-utils/actions/runs/44334725265/job/134908272326),
[retry](https://github.com/overengineeringstudio/effect-utils/actions/runs/44336501265/job/134969061370).
Retry preparation ran 16:51:53–17:07:54 UTC; resolving devenv separately took
35 seconds. A warm retry does not prove fresh-runner substitutability.

[Issue #2605](https://github.com/overengineeringstudio/effect-utils/issues/2605)
owns the prep incident. Prefer a protected publisher realizing the **minimal
pinned checking toolchain**, then read-only substitution on fresh PR runners,
over realizing the whole development shell (including unrelated collector and
reindeer dependencies). A pinned `nix develop` is only useful if its closure is
actually narrower and published: renaming the whole shell preserves its cost.
Compare cold fresh-runner substitution and repeat invocation against the same
head, retain store-path/downloader diagnostics, and preserve the existing
26-minute bound and required checks. No PR cache-write credentials, timeout
increase, workflow cutover or claimed CI speedup is part of this change.
