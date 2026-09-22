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

Revision `e2073b0882` passed the original standalone Buck proofs. Revision
`5b249696f4` then changed only the standalone root to Buck's `notify` watcher.
The branch was rebased onto current PR #1283 and reconciled at revision
`f8528ed38e`, preserving the current parent composition behavior.

- A fresh detached Git worktree with no megarepo state built
  `//packages/@overeng/tui-core:typecheck`.
- `mr store worktree new --commit e2073b0882` produced the compatibility-control
  worktree, and the same target built there.
- The full `//:quick` aggregate completed from the plain worktree.
- After adding a deliberate `number`-to-`string` error to the admitted
  `tui-core` source, `//:quick` failed at
  `//packages/@overeng/tui-core:typecheck` with TS2322. Restoring the source
  returned the worktree to a clean state.
- With Watchman, three unchanged reruns completed in 16-18 ms with no network
  traffic and no scheduled command summary, which is Buck's zero-command
  result.
- With `notify`, three unchanged reruns completed in 16-50 ms with the same
  zero-command and zero-network result.

All accepted samples ran through the shared heavy-command gate. The readings
below were captured immediately before each timed sample.

| Watcher and regime | Elapsed samples | Resource readings before samples | Result |
| --- | --- | --- | --- |
| Watchman, unchanged `//:quick` | 17 ms, 18 ms, 16 ms; median 17 ms | `MemAvailable` 25,741,880 / 25,705,348 / 25,677,884 KiB; slice memory 84,167,573,504 / 84,169,175,040 / 84,181,024,768 bytes; PSI `some avg60` 0.78 / 0.78 / 0.78 | PASS: all samples are below the 5 s BUCK-R07 warm no-op budget |
| `notify`, unchanged `//:quick` | 17 ms, 50 ms, 16 ms; median 17 ms | `MemAvailable` 22,256,252 / 22,243,932 / 22,220,676 KiB; slice memory 82,014,629,888 / 82,013,585,408 / 82,014,101,504 bytes; PSI `some avg60` 0.72 / 0.72 / 0.72 | PASS: all samples are below the 5 s budget; no warm no-op regression |
| Watchman, fresh `buck-out`, warm shared cache | 18.077 s, 8.443 s, 6.412 s; median 8.443 s | `MemAvailable` 25,086,560 / 27,771,072 / 27,709,148 KiB; slice memory 81,304,829,952 / 82,396,282,880 / 82,268,454,912 bytes; PSI `some avg60` 1.38 / 1.08 / 0.95 | PASS: all samples are below the 3 min BUCK-R07 budget; each reported 1,208 cached commands, 100% cache hits, and zero local commands |
| `notify`, fresh `buck-out` | 18.726 s | `MemAvailable` 27,053,620 KiB; slice memory 79,179,030,528 bytes; PSI `some avg60` 1.37 | PASS: below 3 min; 1,208 commands, 668 cache hits (55%), and 540 local commands |
| sandboxed second context, fresh `HOME` / `TMPDIR` / hostname / uid / `buck-out` | 15 min 36.3 s | Heavy-command gate admitted the run; Buck reported 648 MiB peak process memory | FAIL BUCK-R16: 556 cached actions, 633 local actions, 561 other actions, and zero remote actions. Local classes were `package_tree`, `pnpm_store_entry`, `pnpm_store_scc`, `pnpm_store_view`, `tsgo_emit`, and `tsgo_typecheck`. The build later reached the same pre-existing `preferSchemaOverJson` warning and exited non-zero |
| dev4 aarch64 (informational), fresh `buck-out` | 64.2 s | dev4: 31 GiB total memory; 666 MiB peak process memory | INFORMATIONAL: 1,185 cached actions, 8 local actions, 561 other actions, and zero remote actions; local action classes included `package_tree`, `tsgo_typecheck`, and `tsgo_emit`. The build reached the pre-existing `preferSchemaOverJson` warning in `composition-root-publisher.integration.test.ts` and exited non-zero because tsgo treats the warning as exit 2 |
| Warm `devenv shell -- true` | 505 ms, 424 ms, 446 ms; median 446 ms | `MemAvailable` 25,855,352 / 25,799,616 / 25,786,556 KiB; slice memory 81,212,649,472 / 81,204,805,632 / 81,209,909,248 bytes; PSI `some avg60` 1.18 / 1.18 / 1.14 | PASS: all samples are below the 20 s shell-entry budget |

The checked-in standalone root now uses `file_watcher = notify`. The composition
root generator continues to own and emit `file_watcher = watchman`. A regression
guard checks both choices. `notify` retains the 17 ms warm median, stays far
inside the 5 s budget, and avoids the shared Watchman daemon that previously
timed out during root synchronization. The single requested fresh `notify`
sample was 0.649 s slower than the slowest accepted Watchman fresh sample and
had a lower remote-cache hit rate, but it remained far inside the 3 min budget.

The `check:quick` before/after control is the named **S14 mr-row deletion
dependency** under decision 0034. `check:quick` still runs `mr:*` gates that
cannot pass in a standalone worktree by construction. Amendment 3 defers their
deletion and the composed control to S14. The standalone `//:quick` fresh-output
and unchanged-rerun proofs above satisfy S8's aggregate acceptance; S8 makes no
`check:quick` wall-clock claim.

Decision q40 / BUCK-R16 adds a same-platform second-context proof and an
informational cross-architecture observation. The sandbox used a fresh
`HOME`, `TMPDIR`, hostname (`other-host`), uid/gid (4242), and `buck-out` while
sharing only the checked-out revision, `/nix/store`, the Nix database, system
certificates, and the network. It produced 633 local actions, so the required
zero-local-action acceptance does not hold. `buck2 log what-ran` identified
`package_tree`, `pnpm_store_entry`, `pnpm_store_scc`, `pnpm_store_view`,
`tsgo_emit`, and `tsgo_typecheck` as the local action classes. Per q40, the
sandbox was not tuned further to hide this BUCK-R06 key-stability regression.

The dev4 row is the cross-architecture evidence cited by the portable-product
question in `context/buck2/04-reuse/open-questions.md` on PR #1309. The
aarch64 keys were also not fully reusable: eight actions ran locally, across
`package_tree`, `tsgo_typecheck`, and `tsgo_emit`. This is informational and
does not change S8 acceptance.

Strict VRS validation remains blocked by the pre-existing decision-shape errors
in decisions 0035 and 0036 (`Status:`, `Context`, `Evidence and Argument`, and
`Options` are absent according to the current strict schema).

## Conclusion

The standalone Buck root and aggregate meet the original BUCK-R07 warm and
fresh-context budgets. Shell entry also remains within its accepted budget. The
composed store-worktree target control and the broken-package control both
behave as required. `notify` does not regress warm no-op performance and
removes the standalone root's dependency on the flaky shared Watchman daemon.

The new BUCK-R16 second-context proof does not achieve zero local actions:
633 actions ran locally. Under q40, this BUCK-R06 key-stability regression is
the finding and deliverable; no sandbox tuning was used to conceal it.
The `check:quick` composed control is deferred to the named S14 mr-row deletion
dependency by Amendment 3 and does not block S8.

## VRS Impact

This experiment closes the original S8 standalone-root, aggregate, watcher,
and shell-entry measurement gaps. Its same-platform sample initially reported
633 local actions. The
[controlled follow-up](./2026-09-19-second-context-key-stability.md) resolves
that result as a test-ordering artifact: after warming the sampled revision,
the sandbox reused every successful action. S14 owns deletion of the remaining
composition-dependent `check:quick` residual gates and its composed
before/after control.
