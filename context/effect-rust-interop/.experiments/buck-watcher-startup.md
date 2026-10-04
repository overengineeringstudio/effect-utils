# Experiment: Buck watcher startup on a populated worktree

Non-normative operational evidence from [issue #1590](https://github.com/overengineeringstudio/effect-utils/issues/1590), open when consulted. This is a build-verification bottleneck, not Rust algorithm or contract-boundary performance.

## Question

Why do fresh Buck daemons exceed their deadline, and does an ignore-only or crawler change resolve it?

## Hypothesis

Fresh watcher initialization traverses generated editor trees before event ignores apply, exceeding the connection deadline; an ignore-only change will not avoid that startup traversal.

## Method

On a populated Linux x86_64 worktree, pin Buck2 `2026-08-31-be6971d47dcc835b7356e1698b23039ffee4f4c2`. Compare notify with default and fresh isolation, a fresh-isolation ignore-only experiment, and a temporary fs_hash_crawler using the same content-address service targets command. Inspect the pinned watcher implementations. No permanent watcher-policy change is part of the experiment.

## Result

| Fresh daemon scenario | Observed result |
| --- | --- |
| Checked-in notify, default isolation | Connection timeout; 90.99 s command wall time |
| notify, fresh isolation | Connection timeout; 90.77 s |
| Ignore root editor-view tree, fresh isolation | Connection timeout; 90.66 s |
| Temporary fs_hash_crawler, fresh isolation | Connected after 54.33 s; command completed in 111.45 s, approximately 57 s additional full rescan |

Failed notify logs ended at `Creating file watcher`. Generated root and package editor-view trees occupied 407 MiB and 274 MiB. Load1 was 23.24, memory PSI some avg60 0.00, and 78 GiB memory was available. Watchman was not installed.

The pinned [notify backend](https://github.com/facebook/buck2/blob/be6971d47dcc835b7356e1698b23039ffee4f4c2/app/buck2_file_watcher/src/notify.rs) recursively registers the root before applying IgnoreSet to events. The [crawler backend](https://github.com/facebook/buck2/blob/be6971d47dcc835b7356e1698b23039ffee4f4c2/app/buck2_file_watcher/src/fs_hash_crawler.rs) also constructs its snapshot before filtering, rescans at synchronization, and notes missing symlink-target change tracking.

## Conclusion

The measurements establish a reproducible deadline failure and failure of the ignore-only remedy. Unfiltered generated-tree traversal is the supported bottleneck inference, not proof of a daemon deadlock. The crawler enabled fixed-source verification but its observed rescan cost and invalidation limits do not justify an unmeasured permanent substitution.

## Intent Impact

Keep watcher startup and invalidation admission visible as an operational blocker. Temporary fixed-source verification overrides are not a permanent watcher policy.

## Limits and historical distinction

The supplied earlier byte-pilot report had two complete Buck attempts stop before analysis; direct Cargo/runtime smokes did not make those attempts pass. Later [#1602](https://github.com/overengineeringstudio/effect-utils/pull/1602) reports successful Buck parity/service products and restored temporary local watcher overrides. That later success does not resolve #1590 or certify live-source invalidation under the workaround. A retained-warm daemon is not a fresh-start measurement. No Watchman trial, watcher fix, warm-sync distribution, or supported-platform invalidation proof is supplied by this experiment.

The ignore-only experiment was reverted and temporary crawler overrides removed after fixed-source verification. Moving caches, supplying Watchman, or changing upstream registration remain alternatives to measure, not implemented results.

## Sources

- [Buck watcher issue #1590](https://github.com/overengineeringstudio/effect-utils/issues/1590), including exact timings and pinned source links.
- Supplied private byte-pilot report, Buck-limit section; no private locations or machine identities are reproduced.
- [Public byte-engine PR #1602](https://github.com/overengineeringstudio/effect-utils/pull/1602) and [typed-direct PR #1610](https://github.com/overengineeringstudio/effect-utils/pull/1610), for later fixed-source gate evidence and restored overrides; both open when consulted.
