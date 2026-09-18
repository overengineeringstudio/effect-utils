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

The measurement set is pending. The shared heavy-command gate did not grant the final validation command within three hours. The worker followed the task's stop rule instead of running outside the gate.

Evidence collected before the prolonged gate wait:

- The pure `packages.x86_64-linux.buck2-capabilities` derivation built and linked `.buck2/capabilities` to its Nix store output.
- The first standalone `buck2:quick` attempt reached Buck from the repository root, but the shared Watchman service failed root synchronization after a 57-second connection timeout. This was recorded as Axe feedback.
- A subsequent gated `buck2:check` retry waited on the cross-worker serialization lock for more than three hours and exited without running.
- A cached devenv evaluation completed in 1.24 seconds during the failed validation attempt. This is diagnostic evidence only, not an accepted shell-entry sample.

No timing row has the required `n >= 3` and per-sample gate readings yet. No acceptance claim is made from these partial observations.

## Conclusion

The source and focused tests are ready for review, but R16 performance acceptance remains open. Complete the four measurement regimes and both fresh-worktree proofs when the shared heavy-command gate becomes available.

## VRS Impact

This experiment exercises the standalone-root, aggregate, and shell-entry budgets. It does not change their thresholds or authority. The pending result must not be used to close the associated authority-ledger rows.
