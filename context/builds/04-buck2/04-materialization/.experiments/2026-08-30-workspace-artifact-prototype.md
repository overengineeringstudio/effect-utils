# Workspace-Rooted Single Dependency Artifact Prototype

Date: 2026-08-30 — Host: dev3 — Linux x86_64 — Buck2 pin 2026-08-22.

## Question

Is one Buck target that installs the whole workspace `node_modules` as a single
cached artifact a lower-complexity end state than per-package materialization,
once its coarse invalidation is priced?

## Method

Prototyped a `workspace_node_modules` rule in scratch on a synthetic
three-package workspace with peer, scoped, and native dependencies, in both
pnpm-isolated (`--frozen-store --offline --frozen-lockfile`) and Bun-isolated
(global virtual store off) variants, with consumer targets per package. Measured
determinism across builds, relocatability, cache behavior across wiped
`buck-out` and a second isolation dir, invalidation on a dependency bump versus
a source edit, disk sharing for locally built versus cache-restored artifacts,
and editor resolution through symlinked and hardlink-cloned trees. Measured the
real workspace: install time offline from a warm store, artifact size, and
churn across 14 consecutive lockfile commits and 90/180 days of history.

## Result

- Real workspace through Buck: 5.7 s fresh with warm store, 0.02 s warm no-op;
  artifact 807 MB / 40,180 files, 63 MB unshared per worktree when built
  locally, full bytes when cache-restored (all link counts 1).
- Buck propagates on output content, but 0 of 14 real lockfile commits left the
  tree byte-identical; a dependency bump re-ran the artifact and every
  consumer, including unrelated packages. Lockfile churn: 30 of 326 commits in
  90 days, median 2 of 39 packages touched per lock-touching commit.
- Blob-level CAS dedup confirmed: a one-dependency bump uploaded 4.7 KiB.
- Bun variant: byte-identical trees with no normalizer and symlink `.bin`
  entries at synthetic scale; pnpm variant needs a 6-line normalizer for 8
  shims and one state file.
- Symlinking package `node_modules` into the artifact breaks `workspace:`
  links; an in-place hardlink clone resolves everything at ~0 marginal bytes.
- On a cache miss with a cold store the action fails: the ambient store remains
  a Buck-unmanaged precondition.

## Conclusion

The single artifact is the cheapest to build but relocates cost rather than
removing it: it violates DEPS-R07 by construction, cascades into all consumers
on every real lockfile change, loses hardlink sharing on cache hits, and keeps
the ambient store. Rejected as the end state.

## VRS Impact

Option rejected in [decision 0022](../../.decisions/0022-lockfile-derived-declared-closure.md).
DEPS-R07 retained as written.
