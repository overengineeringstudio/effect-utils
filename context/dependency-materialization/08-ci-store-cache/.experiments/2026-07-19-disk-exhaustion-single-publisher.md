# Experiment — self-hosted disk exhaustion and single-publisher fix

Date: 2026-07-19

## Question

Do multiple jobs saving the pnpm store to distinct keys on one shared
self-hosted runner exhaust disk; does routing saves through a single-publisher
primitive remove the exhaustion while keeping the cache warm; and can the
primitive be emitted correctly from generated workflows?

## Method

- Survey the self-hosted consumers of the shared pnpm-state cache. Each
  hand-rolls its own job factory and calls the save step directly, so several
  jobs per workflow write the store.
- Introduce the callable primitives (per-job publisher gate + workflow-level
  stamper) and designate one publisher per workflow.
- Validate generated-workflow emission and step resolution offline (deps absent
  locally), since the type/generation gates run only in the real CI of the
  owning repo.

## Result

- **Failure shape confirmed.** N writers per workflow on a shared runner drive
  the disk-exhaustion class; the divergence is the hand-rolled factories, which
  is why a shared default cannot converge it (see `0001`).
- **Single publisher holds the two-sided invariant.** The workflow-level stamper
  throws on zero publishers and on more than one saver, making never-zero /
  never-many a build-time property rather than a review check.
- **Emission validated.** Generated-workflow emission and step resolution passed
  offline (19/19 resolution checks); the type-check and generated-file freshness
  gates are deferred to the owning repo's CI.
- **Warm-event caveat surfaced.** A candidate publisher job that runs only on
  schedule/admitted events would leave non-admitted runs unable to warm a cold
  key — captured as `DMP.CICACHE-R05` and a per-repo verification checkpoint.

## Conclusion

Single-writer publishing removes the disk-exhaustion class while keeping the
cache warm, and the fail-closed primitive makes never-zero / never-many a
build-time property rather than a review check. The rollout order follows disk
risk: the highest-writer-count consumer first.

## VRS Impact

Supports `DMP.CICACHE-R03`/`R04` (single writer, fail-closed primitive) and the
`0001` decision that single-writer is a callable primitive, not an inherited
default. The warm-event caveat is captured as `DMP.CICACHE-R05` and a per-repo
verification checkpoint.

## Residual

- Half of the contract (paths, version, key) auto-converges via atom defaults;
  the single-publisher half must be adopted per consumer until the hand-rolled
  factories converge onto one shared composer (spec DQ1).
