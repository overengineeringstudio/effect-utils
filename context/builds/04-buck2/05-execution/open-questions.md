# Execution Open Questions

## Resolved: worker image realization and advertisement

The [Namespace experiment](../../.experiments/2026-09-30-namespace-remote-execution.md)
proves the Linux closure/pool mechanism in the
[platform spec](../02-platforms-toolchains/spec.md#executable-providers).
Adoption remains deferred under
[decision 0039](../../.decisions/0039-namespace-first-remote-candidate-adoption-deferred.md).
Darwin re-entry requires a named workload and a fully substitutable closure;
synthetic Darwin execution alone does not prove BUILD.BUCK.PLAT-R05.

## Findings from the observability lane (recorded 2026-09-25, q8)

Measured in cold CI via the [07-observability](../07-observability/spec.md)
lane; the fixes are owned here, not there:

- **Serial emit chain:** the cold check aggregate's critical path is a
  serial chain of `tsgo_emit`/`tsgo_typecheck` actions (~165 of 204 s wall).
- **8-slot contention:** ~1,070 cheap pnpm store/extract actions accumulated
  3,729 s of summed queue time in the 204 s CI observation. Summed queue time
  does not identify the critical path or prove that extraction waited behind
  TypeScript. The separate quiet-host 2026-09-30 runs (34.7/36.1 s) show a
  23.5/24.8 s serial TypeScript suffix; 99.6% of summed extract/entry waiting
  occurs before TypeScript starts. Their pnpm/package-tree critical path is
  10.7 s, mostly slot queueing. A fusion prototype reduced command boundaries
  (1,285 → 737) but showed no local win above host-load variance
  ([attribution and prototype](../../.experiments/2026-09-30-namespace-remote-execution.md#local-critical-path-and-batching-prototype)).
- **Daemon wait at scale:** on concurrent same-daemon CI commands, one
  command waited 79.5 s (62% of its 128 s wall) on another's actions
  ([daemon-wait bakeoff](../07-observability/03-event-log-adapter/.experiments/2026-09-25-daemon-wait-attribution-bakeoff.md)).

## BUILD.BUCK.EXEC-DQ02: Filesystem/network sandbox enforcement

[Spec](./spec.md#audited-action-inventory) records the audited action inventory,
native env-scrubbed launcher and default-deny execution platforms. These enforce
startup env and shared-cache admission, not a general filesystem/network sandbox.
The remaining question is feasible OS containment where declared-closure controls
cannot enforce undeclared reads. Host-dependent/unlisted lanes stay uncached.
