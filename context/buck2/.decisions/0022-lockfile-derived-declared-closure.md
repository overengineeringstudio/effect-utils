# 0022 Lockfile-Derived Declared Dependency Closure

Status: accepted

## Context

Decision [0015](./0015-buck-owned-dependency-surface.md) made Buck the owner of
dependency materialization by running pinned pnpm inside actions: a `deploy`
prune, a frozen offline install against an ambient content-addressed store, a
deploy-tree normalizer, and a canonical install descriptor. The production cp-a
member run
([../05-composition/.experiments/2026-08-30-production-cp-a-member-e2e.md](../05-composition/.experiments/2026-08-30-production-cp-a-member-e2e.md))
exposed the structural cost of that shape: the ambient store is mutable,
Buck-unmanaged state that must exist, be warm, and be same-mount in every
composition shape, and every new mount topology must route around it. The human
asked for the end state with the lowest global complexity, indifferent between
pnpm and Bun as tools.

## Evidence and Argument

Three prototypes and a complexity ledger were produced on 2026-08-30:

- [2026-08-30-declared-closure-prototype.md](../03-materialization/.experiments/2026-08-30-declared-closure-prototype.md):
  the rules_js model on stock Buck2 primitives works end to end in 188 lines;
  the real lockfile translates to 1,319 targets in 0.21 s; one dependency
  change re-runs 3 actions; assembled trees carry zero absolute symlinks and
  cost 2.2% marginal disk over content; node and tsc resolve without
  `--preserve-symlinks`.
- [2026-08-30-workspace-artifact-prototype.md](../03-materialization/.experiments/2026-08-30-workspace-artifact-prototype.md):
  a single workspace-rooted artifact is cheapest to build but violates DEPS-R07
  by construction — 14 of 14 real lockfile commits changed the artifact bytes,
  cascading into every consumer — and cache-restored artifacts lose hardlinks
  (full tree bytes per worktree).
- [2026-08-30-read-only-store-frozen-store.md](../03-materialization/.experiments/2026-08-30-read-only-store-frozen-store.md):
  the ambient-store design is repairable (`--frozen-store` plus store
  relocation), which bounds the cost of the alternative rather than motivating
  it.
- Complexity ledger (session evidence, 2026-08-30): today's materialization
  machinery is ~8,600 lines across six concerns with nine state locations; the
  declared-closure model deletes ~1,900 TS/Starlark lines and up to ~1,540 Nix
  lines against ~550–700 projected at parity, and removes the ambient-store
  state class entirely.

Bun as the install tool was ruled out on a silent `patchedDependencies` drop
with exit 0 on the real manifests (a wrong-green result, the defect class this
subsystem exists to eliminate). Under the declared-closure model the fetcher is
irrelevant: no package manager runs at build time.

## Options

| Option                            | Tradeoff                                                                                          | Outcome  |
| --------------------------------- | ------------------------------------------------------------------------------------------------- | -------- |
| Lockfile-derived declared closure | ~550–700 lines at parity vs ~1,900 deleted; no ambient store; structural bounded fan-out; sidecar | Accepted |
| Ambient store, repaired           | ~150–250 lines; ratifies ~8,600 lines and nine state locations; mutable store stays               | Rejected |
| Workspace-rooted single artifact  | ~400 lines; violates DEPS-R07; 36-consumer cascade per lockfile commit; no hardlinks on cache hit | Rejected |

## Decision

Dependency materialization is a lockfile-derived declared closure. Genie
translates `pnpm-lock.yaml` into Buck targets: one hash-pinned fetch and one
extract target per package version, and one assembly target per importer that
lays out a pnpm-shaped virtual store with relative symlinks and hardlinks from
the extract artifacts. No package manager executes inside Buck actions; pnpm
remains the developer-time resolver that writes the lockfile. The editor
surface is unchanged: `editor-view.ts` publishes assembled trees through the
snapshot-and-rename flip (DEPS-R05), which the prototype re-proved necessary.
`pnpm deploy`, the deploy normalizer, the install descriptor, the ambient store
and its warm lane, and the CI store cache lane are deleted when the two
admitted packages consume the new provider. This decision supersedes the
mechanism of decision 0015; its authority claim (BUCK-R11) stands.

Adoption sequence (q3, 2026-08-30): the closure provider is built behind the
admitted packages and lands together with the Phase-2 cutover PR rather than
after it, so the superseded provider never reaches `main`. Phase-3 widening
resumes on the new provider.

## Consequences

- The Phase-2 locked-member gate dissolves: there is no store to be read-only.
- Bounded fan-out (DEPS-R07) is structural, not engineered; the prune→install
  split and normalization gate of 0015 Amendment 1 are retired.
- A genie-generated sha256 sidecar is required because `download_file` accepts
  only sha1/sha256 while the lockfile carries sha512; the sidecar is derived,
  verified against the lockfile at generation, and freshness-gated. It is a
  new derived-drift surface and is scored as an addition.
- Platform filtering via `select()` on cpu/os constraints is mandatory; without
  it 18.8% of fetches are wasted.
- Hardlink aliasing inside `buck-out` is a recorded hazard shared with the
  previous design: Buck resets output modes, so protection holds only on the
  published editor view (0444).
- Cold bootstrap is slower (~85 s serial across 37 parallelizable assemblies
  versus ~20 s) while incremental cost falls (one importer reassembly versus
  44–79 s reconvergence).
- CI starts with the simplest wiring — registry downloads per run — and
  refines later (q4, 2026-08-30).
- Nix consumers no longer maintain `pnpmDepsHash` values for admitted tools;
  products cross via import (BUCK-R10 by dissolution).
