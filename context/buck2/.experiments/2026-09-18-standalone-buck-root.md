# Standalone Buck root

Date: 2026-09-18
Host: dev3 (x86_64-linux)

## Question

Does a plain effect-utils worktree build the admitted Buck graph without megarepo composition, and do the warm no-op, warm-cache/fresh-output, `check:quick`, and shell-entry measurements remain within the accepted budgets?

## Method

Run every Buck, Nix, and devenv command through `/srv/bulk/coding-agents/_briefs/buck2-heavy.sh`. Before each accepted sample, record `MemAvailable`, `user-1000.slice/memory.current`, and memory PSI `some avg60`. Measure at least three samples for each regime:

1. `buck2 build //:quick` after an unchanged successful build.
2. `buck2 build //:quick` with a fresh Buck output directory and a warm remote cache.
3. `check:quick` before and after the standalone-root change.
4. `devenv shell -- true` after one untimed warm-up.

Use a fresh `git worktree add` checkout with no megarepo state for the standalone samples. Use an `mr store worktree new` root only for the composed compatibility proof. Verify the deliberately broken admitted-package control and the unchanged rerun's local action count separately from the timing samples.

## Result

Revision `e2073b0882` passed the standalone Buck proofs:

- A fresh detached Git worktree with no megarepo state built
  `//packages/@overeng/tui-core:typecheck`.
- `mr store worktree new --commit e2073b0882` produced the compatibility-control
  worktree, and the same target built there.
- The full `//:quick` aggregate completed from the plain worktree.
- After adding a deliberate `number`-to-`string` error to the admitted
  `tui-core` source, `//:quick` failed at
  `//packages/@overeng/tui-core:typecheck` with TS2322. Restoring the source
  returned the worktree to a clean state.
- Three unchanged reruns completed in 16-18 ms with no network traffic and no
  scheduled command summary, which is Buck's zero-command result.

All accepted samples ran through the shared heavy-command gate. The readings
below were captured immediately before each timed sample.

| Regime | Elapsed samples | Resource readings before samples | Result |
| --- | --- | --- | --- |
| Unchanged `//:quick` | 17 ms, 18 ms, 16 ms; median 17 ms | `MemAvailable` 25,741,880 / 25,705,348 / 25,677,884 KiB; slice memory 84,167,573,504 / 84,169,175,040 / 84,181,024,768 bytes; PSI `some avg60` 0.78 / 0.78 / 0.78 | PASS: all samples are below the 5 s BUCK-R07 warm no-op budget |
| Fresh `buck-out`, warm shared cache | 18.077 s, 8.443 s, 6.412 s; median 8.443 s | `MemAvailable` 25,086,560 / 27,771,072 / 27,709,148 KiB; slice memory 81,304,829,952 / 82,396,282,880 / 82,268,454,912 bytes; PSI `some avg60` 1.38 / 1.08 / 0.95 | PASS: all samples are below the 3 min BUCK-R07 budget; each reported 1,208 cached commands, 100% cache hits, and zero local commands |
| Warm `devenv shell -- true` | 505 ms, 424 ms, 446 ms; median 446 ms | `MemAvailable` 25,855,352 / 25,799,616 / 25,786,556 KiB; slice memory 81,212,649,472 / 81,204,805,632 / 81,209,909,248 bytes; PSI `some avg60` 1.18 / 1.18 / 1.14 | PASS: all samples are below the 20 s shell-entry budget |

The `check:quick` before/after comparison did not produce accepted performance
samples. The parent revision exited after 20.327 s and the S8 revision exited
after 19.465 s. Both clean store worktrees failed at the same pre-existing
composition boundary: `mr:setup` and `mr:source-policy-check` reject the flat
store worktree as a legacy workspace before `buck2:quick` can run. These are
failure latencies, not benchmark values.

One earlier unchanged rerun also hit the shared Watchman service's 57-second
reconnect timeout after the cold aggregate populated the worktree. A subsequent
fresh-output series and the accepted unchanged series completed without that
failure, so the accepted timing rows do not include the failed attempt.

Strict VRS validation remains blocked by the pre-existing decision-shape errors
in decisions 0035 and 0036 (`Status:`, `Context`, `Evidence and Argument`, and
`Options` are absent according to the current strict schema).

## Conclusion

The standalone Buck root and aggregate meet the BUCK-R07 warm and fresh-context
budgets. Shell entry also remains within its accepted budget. The composed
store-worktree target control and the broken-package control both behave as
required.

`check:quick` is not proven green from a flat store worktree. Its retained
source-side residual gates still require a non-legacy composed workspace, so no
before/after performance claim is made for that verb.

## VRS Impact

This experiment closes the standalone-root, aggregate, cache, and shell-entry
measurement gaps. It does not change their thresholds or authority. The
`check:quick` evidence remains open until the composition-dependent residual
gates have a runnable composed control.
