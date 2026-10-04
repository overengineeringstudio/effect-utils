# Competitive benchmark: root-install surface vs Buck-owned surface

Date: 2026-08-25
Host class: x86_64-linux development host (dev3), buck2 pin 2026-04-14, pnpm 11.8.0

## Question

On real developer scenarios over real packages, what does the Buck-owned
dependency surface cost and buy against the status-quo root `pnpm install`
surface? Feeds decision 0015.

## Method

- Two independent agents ran an identical 7-scenario protocol (pure edit,
  sibling propagation kdl→kdl-effect and utils→dependent, dep add/remove,
  fresh bootstrap, branch/lockfile switch, drift, vitest loop) on separate
  clones, each championing one surface, each producing raw auditable timing
  logs; medians of 3 where timing mattered; manual actions counted.
- Load caveat: dev3 ran at loadavg 34–136 on 32 cores throughout both runs.
  Cross-champion absolute wall-clock is contaminated; the comparison currency
  is action counts and correctness outcomes, plus the one paired block where
  both arms ran back-to-back.
- Instrument substitution, proven before use: one-shot `tsgo -p <sibling>`
  returns rc=0 with zero output on a stale sibling `dist` (8/8
  reproductions), while a TypeScript LanguageService probe with
  source-of-project-reference redirection (tsserver's default) reports the
  error — so `tsgo --build` was the CLI instrument, and the false green is a
  CLI/CI hazard, not an editor hazard.
- Both champions retracted early errors of their own with root causes (probe
  layout not named `node_modules`; `pnpm add --lockfile-only` materializing
  into the live view), preserving auditability.

## Result

- Headline: the symlink-back fix landed on the Buck surface — workspace
  siblings resolve as live source symlinks. Paired block (kdl export renamed,
  kdl-effect consumer): fixed surface = 1 action, 0 buck2 commands, 0
  refreshes, 601 ms to the error; unfixed injected-copy surface = silently
  green after save, still green after a 5.1 s rebuild+flip, error only after
  also discarding TS build state — 3 actions, ~8.4 s. The silence, not the
  seconds, is the finding.
- Root-install strengths (measured, not asserted): sibling edit surfaces in
  the editor in 103 ms with zero commands (workspace links consume sibling
  source via dev `exports`); sibling-edit→retest 0.9 s; best-case
  clone-to-green bootstrap ~3.3 s; dep change ~12 s pnpm-attributable.
- Buck-surface strengths: drift is loud — the fingerprint check exits 1 naming
  both manifests when the view is stale, while the root surface goes silently
  green on a removed dep (phantom dependency, no detection;
  `verifyDepsBeforeRun` cannot help because tools are invoked directly).
  10/10 consecutive lockfile edits invalidated correctly under watchman plus
  a content settle step — the earlier 1-in-5 flake root-caused to the
  `notify` file-watcher default the repo's own `.buckconfig` comment warns
  about. Dependency trees are declared, verifiable artifacts (42 inputs,
  688 KB: all manifests + lockfile + workspace file + patches; no source file
  is an input).
- Shared findings, independently hit by both champions: `tsgo --build`'s
  up-to-date check hashes sources and referenced projects only and ignores
  `node_modules` content (17 ms false green after dep removal + reinstall;
  `touch` does not invalidate) — a standing hazard for CI trusting
  incremental state across dependency changes, orthogonal to the surface
  choice. A live tsserver is more robust than the batch checker (sees flips
  and redirects without restart). Every dep change pays a ~10 s genie
  regeneration constant on either surface.
- Remaining Buck-surface cost, unhedged: manifest-change fan-out. The shared
  manifest skeleton invalidates every cell, so branch-switch reconvergence
  measured 44–79 s (9 cells) vs ~3 s, bootstrap ~20 s median (9–44 s spread,
  daemon warmth) vs ~3.3 s, dep changes ~2–3x. Named structural fix, unbuilt:
  key each cell's install on the per-package pruned lockfile that
  `pnpm deploy` already emits.
- Disk: effectively neutral — sharing flows through the pnpm store on both
  surfaces (marginal second surface ≈ 111 MB, 99% of `buck-out` bytes
  hardlinked to the store).

## Conclusion

The inner loop is equivalent after the symlink-back fix; correctness
decisively favors the Buck surface; manifest-change events favor the root
install until per-cell pruned-lockfile keying lands. Decision 0015 adopts
Buck-owns-all with cutover gated on that keying plus a real-editor soak.

## VRS Impact

Decides [decision 0015](../../.decisions/0015-buck-owned-dependency-surface.md)
and grounds DEPS-R03 (live workspace siblings via symlink-back), DEPS-R06
(loud staleness versus the status quo's silent phantom-dependency green), and
DEPS-R07 (per-cell pruned-lockfile keying as the fan-out gate).
