# Declared Dependency Closure Prototype on Buck2

Date: 2026-08-30 — Host: dev3 — Linux x86_64 — Buck2 pin 2026-08-22.

## Question

Can a lockfile-derived declared closure (the rules_js model) materialize
per-package `node_modules` trees on stock Buck2 primitives with no ambient
store, and what does it cost against today's deploy-based materializer?

## Method

Researched rules_js at source level (translate-lock, npm_import with lockfile
integrity, virtual-store layout, platform `select()`, lifecycle and `.bin`
handling, editor answer) and searched for Buck2 prior art. Wrote a 188-line
prototype in scratch: a translator (102 lines) emitting one fetch target and one
extract target per package version plus one assembly target per importer from
`pnpm-lock.yaml` v9, rules (60 lines) using `download_file` and local
assembly, and an assembler (26 lines). Ran it on a synthetic two-importer
workspace and on the real repository lockfile (641 packages, 37 importers) in a
private isolation dir. Measured target counts, translation time, warm no-op,
single-dependency invalidation, node CJS/ESM/peer/workspace resolution, tsc,
relocatability, disk marginal cost over content, and the editor ENOENT window
for a naive symlink versus the existing snapshot-and-rename flip.

## Result

- Real lockfile: 1,319 targets in 0.21 s; warm no-op 43 ms with zero actions.
- One dependency version change: 3 actions (two extractions, one importer
  reassembly); the other importer untouched.
- Node resolution passes for CJS, ESM, peer-suffixed store entries, and live
  `workspace:` siblings without `--preserve-symlinks` or fs patching; tsc passes
  and a negative control proves types come from the closure.
- Relocatability: 0 absolute symlinks, 0 dangling, 0 `buck-out` strings.
- Disk: 13.4 MB marginal on 609 MB content (2.2%), hardlinks verified by inode.
- Assembly of 413 store entries: 4.52 s under load 84 (~85 s serial repo-wide,
  parallelizable across importers).
- Editor: naive symlink into `buck-out` showed 20,225 absent samples of
  1,435,078 across rebuilds; the snapshot-and-rename flip showed 0 of 662,530.
- `download_file` rejects sha512; a derived sha256 sidecar is required.
- Platform filtering: 18.8% of fetches wasted without cpu/os `select()`.
- Hardlink aliasing: a write through an assembled tree corrupts the shared
  artifact; `chmod` inside `buck-out` is reset by Buck; 0444 holds on the
  published view.
- No Buck2 prior art reads a lockfile; `prelude/js` is Metro bundling only.
- Lifecycle scripts and `.bin` synthesis are exempt here: `requiresBuild` is 0
  and builds are disallowed by ratified policy; 40 `hasBin` entries are
  symlinks.

## Conclusion

The model works and is substantially simpler than today's machinery: it deletes
the deploy normalizer, install descriptor, materializer, most of
`materialization.bzl`, the ambient store and warm lane, and the CI store cache
lane (~1,900 lines) against 188 measured and 550–700 projected at parity, and
it removes the ambient-store state class. It does not delete the editor view,
which is re-proven necessary. Costs are a gated sha256 sidecar, mandatory
platform filtering, the shared hardlink hazard, and a slower cold bootstrap.

## VRS Impact

Ratified as [decision 0022](../../.decisions/0022-lockfile-derived-declared-closure.md);
decision 0015 superseded in mechanism (Amendment 3); DEPS-A02, DEPS-T01,
DEPS-R02, DEPS-R04, DEPS-R07, and DEPS-R08 re-tensed to the closure mechanism.
