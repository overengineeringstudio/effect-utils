# Standalone check surface

Date: 2026-09-20

## Question

Can effect-utils run its repository check graph from the standalone repository root without invoking megarepo setup, apply, or validation tasks?

## Method

Run every Buck, Nix, and devenv command through the shared heavy-command gate. Capture three warm `check:quick` samples before and after the task-graph change. Run `check:all` once. Inspect the evaluated task graph and require both check aggregates and every Buck-backed repository task to avoid `mr:setup`, `mr:apply`, `mr:check`, `mr:lock-sync-check`, and `mr:source-policy-check`.

The inherited branch could not evaluate its devenv task graph because the committed Genie product descriptor and its import contract disagree about the `opentui-core-native` capability. A temporary local alignment let the task graph evaluate for structural inspection. The alignment was then reverted and is not part of this change.

## Result

| Probe | Samples | Result |
| --- | --- | --- |
| Before, warm `check:quick` | 68.280 s, 10.235 s, 9.012 s | REJECTED: all three failed during devenv evaluation with `javascript-product-import: external capability mismatch` |
| After, warm `check:quick` | 2.183 s, 2.081 s, 1.950 s | REJECTED: all three reused the diagnostic evaluation and failed in inherited Genie generation; the committed product reports `nixCacheSetupStep is not defined` |
| After, `check:all` | 8.701 s | REJECTED: inherited Genie, Nix flake, and Rust workspace checks failed |
| Task graph assertions | 205 assertions | PASS: `mr:setup` and the three composition checks are absent, both check aggregates avoid `mr:apply`, and standalone Buck tasks retain the `genie:check` freshness edge |
| Standalone format task | 14.654 s | INCONCLUSIVE: the task reached the repository-root Buck target without composition, but an unavailable remote-cache credential caused retries and the probe was interrupted |

The before and after timings are failure timings. They do not support a performance comparison. They are retained to make the blocked control explicit rather than presenting rejected samples as successful evidence.

The task graph retains `mr:bootstrap`, `mr:fetch-apply`, `mr:lock`, and `mr:apply` as explicit repository-composition operations. None is reachable from `check:quick` or `check:all`.

## Conclusion

The structural cut is complete: repository checks and Buck-backed check tasks no longer depend on composition. The repository-level runtime proof is blocked by an inherited stale Genie product, so this experiment does not claim a green aggregate or a speedup. The accepted evidence is the 205-assertion task-graph proof.

## VRS Impact

The composition spec now defines the repository root as the check root and limits mr to explicit composition operations. The three residual ledger rows for `composition-mr-check`, `composition-mr-lock-sync-check`, and `composition-mr-source-policy-check` can close when this change lands. The stale Genie product must be repaired by its owning publication slice before successful aggregate timings can replace the rejected samples above.
