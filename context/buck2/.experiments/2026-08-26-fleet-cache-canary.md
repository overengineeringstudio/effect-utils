# First Fleet-Cache Canary: Cross-Worktree Zero Re-Execution

Date: 2026-08-26 — Host: dev3 (x86_64-linux) — Buck2 pin 2026-04-15
(`pkgs.buck2`), fleet service from dotfiles#2048.

## Question

Does the repository, wired per the validated client contract
([decision 0013](../.decisions/0013-shared-cache-foundation.md),
[04-reuse spec](../04-reuse/spec.md)), achieve BUCK-R06 zero re-execution
for unchanged targets in a second same-platform context against the DEPLOYED
fleet cache (dev3 bazel-remote, gRPC :41045) — not the localhost probe of the
2026-08-25 selection experiment?

## Method

Wiring landed as commit `20f68d4df` on `schickling/2026-08-11-buck2`:
devenv-generated gitignored `.buckconfig.local` (SHA256 digests, upload
defaults, single `grpc://` endpoint, `instance_name = effect-utils`,
`tls = false`, `BUCK2_NO_REMOTE_CACHE=1` disable toggle) plus executor
`remote_cache_enabled/allow_cache_uploads` in `buck2/platforms/defs.bzl`.

1. Populate: context A (`schickling/2026-08-11-buck2`) ran
   `buck2 build //:buck2_foundation --local-only`: 2 commands, local: 2,
   uploads flowed.
2. Context B: branchy fork at the identical commit; `buck2 kill`;
   `rm -rf buck-out`; identical build command.
3. Disable toggle checked separately: shell entry with
   `BUCK2_NO_REMOTE_CACHE=1` removes `.buckconfig.local`.
4. Failure-mode drill (unplanned): an intermediate run against a context B
   WITHOUT the wiring produced `Cache hits: 0%` with no RE Session line —
   confirming the client contract is load-bearing and that a mis-wired
   context degrades to local execution rather than failing (cache absent =
   silent local-only, cache present-but-unreachable = hard fail).

## Result

Context B after kill + wipe: `Cache hits: 100%`, `Commands: 2 (cached: 2,
remote: 0, local: 0)`, RE Session connected. Zero locally executed actions —
BUCK-R06 holds cross-worktree at identical revision on the deployed service.
Build wall time 1.8 s including daemon start. Toggle verified: file removed,
next build runs purely locally.

## Conclusion

Phase 0's remaining items are complete: the deployed fleet cache serves real
repository targets across worktrees with zero re-execution, and the outage
escape hatch works. The canary runbook in 04-reuse/spec.md is exercised
end-to-end with Buck-native evidence (build-report cache-hit classes). The
silent-local-only degradation when the config section is missing entirely is
acceptable pre-transfer (nothing admitted depends on caching yet) but must be
revisited once admitted surfaces rely on reuse (REUSE-R02 investigations key
off `buck2 log what-ran`).

## VRS Impact

Validates REUSE-R01/R02 mechanics on the deployed fleet service; grounds the
Phase 0 checklist completion in epic #1147; no requirement changes. Phase 1
budget gates (BUCK-R07) now measurable against this baseline.
