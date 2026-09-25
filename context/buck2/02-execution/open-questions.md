# Execution Open Questions

## Open 2026-09-19: how is the worker image realized and advertised?

BUCK-R17 requires a worker to hold the exact Nix closure an action's tools come from. Undecided: whether workers share the host Nix store (same-host or `nix copy` of the closure before scheduling), how the closure identity becomes a platform property the scheduler matches, and how Darwin actions (EXEC-R05) are placed. Blocked on: the NativeLink phase's first experiment (the #1317 kit could not start on aarch64; an x86_64 worker host with free memory is needed).

## Findings from the observability lane (recorded 2026-09-25, q8)

Measured in cold CI via the [07-observability](../07-observability/spec.md)
lane; the fixes are owned here, not there:

- **Serial emit chain:** the cold check aggregate's critical path is a
  serial chain of `tsgo_emit`/`tsgo_typecheck` actions (~165 of 204 s wall).
- **8-slot contention:** ~1,070 cheap pnpm store/extract actions queue
  3,729 s (summed) behind the 8 local slots while multi-second tsgo actions
  run.
- **Daemon wait at scale:** on concurrent same-daemon CI commands, one
  command waited 79.5 s (62% of its 128 s wall) on another's actions
  ([daemon-wait bakeoff](../07-observability/03-event-log-adapter/.experiments/2026-09-25-daemon-wait-attribution-bakeoff.md)).
