# 0015 Buck-Owned Dependency Surface Including the Editor View

Status: accepted

## Context

Dependency state had two possible steady shapes: a dual surface (root
`pnpm install` for editors, Buck materializations for builds) or Buck owning
everything with no hand-run install. The dual surface permanently carries the
silent-drift class the ecosystem has failed to fix (aspect rules_js #854, open
since 2023: builds work or intellisense works, never both without a second
uncontrolled install).

## Evidence and Argument

Prototypes and a competitive benchmark (two independent agents, identical
7-scenario protocol on real packages; retained in
[../03-materialization/.experiments/](../03-materialization/.experiments/))
established:

- Per-package materialization is a 1–3 s Buck action from a manifest-only
  skeleton (`pnpm deploy --offline`): no source file is an input, so no source
  edit invalidates a dependency tree. Determinism holds after fixed-path
  staging and normalization of an enumerable impurity set.
- The editor surface works through a two-hop stable symlink flipped by
  `rename(2)` over `cp -al` snapshots (zero dangling window); a live tsserver
  survives flips without restart; vitest runs through the view.
- The two blocking caveats were resolved: workspace siblings become live source
  symlinks (the symlink-back fix — inner-loop parity with the root install:
  one action, no rebuild, no restart), and the invalidation flake was
  root-caused to the `notify` file watcher (deterministic under watchman plus a
  content settle step; 10/10 lockfile edits converged).
- The remaining honest cost concentrates at manifest-change events: dep changes
  ~2–3x slower, branch-switch reconvergence 44–79 s versus ~3 s, bootstrap
  ~20 s versus ~3 s — driven by the shared manifest skeleton invalidating every
  cell. The named fix is per-cell pruned-lockfile keying (deploy emits a
  per-package pruned lockfile; keying each cell's install on it stops
  unrelated manifest churn from fanning out).
- The status quo's structural defect is unrepairable in kind: a removed dep
  leaves local dev silently green (phantom dependency), and `tsgo --build`'s
  up-to-date check ignores node_modules content entirely, so nothing surfaces
  the drift. Guards can detect it; only Buck ownership couples detection to
  repair.
- In this repository the root install's only job is the symlink forest — root
  `node_modules` holds no top-level packages and no `.bin`; Nix owns all
  tools. The surface being replaced is small and mechanical.
- Disk is not a differentiator: deploy trees hardlink-share through the pnpm
  store (measured: six trees summing to 2.3 GB occupy 660 MB).

## Options

| Option                                      | Tradeoff                                                                                   | Outcome  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ | -------- |
| Buck owns all; cutover gated on fan-out fix | Single authority, drift impossible silently; rare events slower until the keying fix lands | Accepted |
| Commit immediately, fix in flight           | Fastest to single authority; first impressions formed on 44–79 s branch switches           | Rejected |
| Dual surface as end-state                   | Fast manifest events; permanent silent-drift class and two lockfile projections            | Rejected |

## Decision

Buck owns dependency materialization end to end, including the editor surface;
manifests and the lockfile are the only hand-authored dependency inputs
(BUCK-R11). The editor-surface cutover is an authority transfer under
BUCK-R12, gated on: (1) per-cell pruned-lockfile keying built and measured to
remove the manifest-change fan-out, and (2) a real-editor soak on one package.
Until the gate passes, the root install is transitional and carried in the
deletion ledger. Materialization actions are `local_only`: pnpm's virtual-store
keys embed absolute paths, so node_modules trees are not portable across
machines; cross-machine caching applies to the actions consuming them.

## Consequences

- The drift class exits the system at cutover; a stale surface fails loudly
  (vision criterion 8).
- Manifest-change latency is a watched budget, not an accepted regression:
  the keying fix is gate work, and BUCK-R07 applies.
- Store wiring must be explicit (`--store-dir`; `PNPM_STORE_DIR` is ignored)
  and same-filesystem so hardlinking holds (BUCK-R08).
