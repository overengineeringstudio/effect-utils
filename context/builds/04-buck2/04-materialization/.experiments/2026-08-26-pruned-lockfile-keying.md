# Pruned-Lockfile Keying and the Fan-Out Root Cause

Date: 2026-08-26 — Host: dev3 (loadavg 63–108/32; wall-clock indicative only).
pnpm 11.8.0, Buck2 2026-04-14.

## Question

Does per-cell pruned-lockfile keying (DEPS-R07, the decision-0015 gate) stop
unrelated manifest churn from invalidating all cells, and is the pruned
lockfile stable enough to key on?

## Method

Six real cells (tui-core, kdl, kdl-effect, utils-dev, utils, restate-effect)
plus downstream consumer targets under real Buck2. 9 cells x 9 rounds = 81
cell-observations across unrelated- and related-change classes, oracle =
normalized tree hash. Working two-stage graph (prune -> install) built and
measured; single-stage measured before/after normalization fixes; the cheap
mini-workspace `--lockfile-only` prune tested against the real deploy.

## Result

- **Premise corrections:** the deploy-root `pnpm-lock.yaml` is NOT the pruned
  artifact — it prunes only `importers:` and its package set GROWS (712/471 vs
  the full lockfile's 675/446) from single-importer peer re-resolution. The
  genuinely pruned artifact is `<deploy>/node_modules/.pnpm/lock.yaml`
  (115/80, 36 KB vs 347 KB) and it is an INSTALL BYPRODUCT: stage 1 must run
  a real deploy and discard the tree. The "free ~0-LOC two-stage upgrade" the
  spec claimed does not exist.
- **Raw pruned bytes are unusable as a key:** one unrelated `pnpm add`
  outside every cell's closure false-invalidated 7–8 of 9 cells with
  byte-identical installed output — pnpm re-serializes DECLARED peer ranges
  inconsistently under unrelated workspace churn (`@effect/vitest@0.29.0`
  flips between `effect: 3.21.4` and `effect: ^3.21.0`). Likely an upstream
  pnpm bug worth filing.
- **Canonicalization validates:** two normalizations (absolute staging path ->
  `file://<WS>` placeholder; drop declared peer ranges from `packages:` while
  keeping resolved peer suffixes in snapshot keys) made the key exactly
  precise and exactly sound in every round. Positive controls fire correctly
  (vitest removal fires only tui-core; a kdl dep add fires kdl + kdl-effect).
- **The fan-out's actual root cause was a normalization bug:** the prototype's
  `sed '/^prunedAt:/d'` never matched because `.modules.yaml` is JSON in pnpm
  11.8, so every materialized tree carried a fresh timestamp, every rebuild
  changed the output digest, and every consumer cascaded. Fixing `prunedAt`
  properly and deleting `.pnpm/lock.yaml` from inside the tree (it describes
  the tree it lives in — self-referentially unstable) took an unrelated
  manifest change from 13 actions (all consumers re-ran) to 7 actions with
  ZERO consumers re-running, single-stage, no graph change.
- **Two-stage vs single-stage after the fix:** wall-clock within noise
  (5.42 s vs 6.00 s; reversed order 4.14 s vs 4.67 s under heavy load). The
  durable two-stage arguments are action count and write volume: single-stage
  still re-runs all 6 deploys and rewrites 6 x 274–608 MB into buck-out per
  manifest touch; two-stage runs 6 cheap prunes emitting 36–140 KB and only
  affected installs. Measured two-stage behavior: no-op 0.41 s / 0 actions;
  unrelated change 7 actions / 0 stage-2 / all trees byte-identical; related
  change exactly 1 stage-2 and 1 changed output.
- **Cheap prune REJECTED on correctness, not cost:** a mini-workspace of the
  closure with `pnpm install --lockfile-only` re-resolves — picked
  `@msgpackr-extract/*@3.0.4` where the real deploy resolves `3.0.3`, and
  over-approximated kdl-effect by 51 snapshots. Stage 1 must use the real
  deploy byproduct.
- Mechanical gotchas (handled in the prototype): deploy strips
  `packageExtensionsChecksum`/`injectWorkspacePackages` from the settings
  block, so a stage-2 root must derive settings from the lockfile; the
  lockfile records patch HASHES where the workspace file needs PATHS; `file:`
  deps resolve relative to the INSTALL ROOT, so siblings must exist at
  repo-relative paths under staging. Stage-2 frozen replay is
  platform-correct: it omits 131 foreign-platform optional-dep entries that
  deploy over-materializes — strictly one-directional (DEPS-T01).

## Conclusion

Most of the promised fan-out win is a normalization bug fix, not a keying
change: land the normalization fixes first (cheap, independent, kills the
consumer cascade). The two-stage split is then a separate choice: it is the
only shape satisfying DEPS-R07's literal reading (unrelated churn must not
rebuild every TREE — single-stage still re-runs every deploy and rewrites
hundreds of MB), while the purpose reading (bound invalidation, no cascade)
is satisfied without it. Decide on the reading, not on wall-clock. The
canonicalization step is required in either shape.

## VRS Impact

Corrects 03-materialization spec §Materialization Action (pruned artifact is
an install byproduct; canonicalization required; exact normalization set);
resolves the decision-0015 gate's keying question into a normalization fix
plus a DEPS-R07 reading choice; flags an upstream pnpm serialization bug as a
repro candidate.
