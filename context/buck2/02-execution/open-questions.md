# Execution Open Questions

## Resolved 2026-09-30: worker image realization and advertisement

The [Namespace experiment](../.experiments/2026-09-30-namespace-remote-execution.md)
answers the 2026-09-19 question for Linux x86_64: an immutable named pool per
capability closure identity realizes the complete closure before worker
registration. The capability projection root is required in addition to
manifest tool paths, and the client links directly to the store root.
Platform properties bind closure identity into the action key. Real package
typecheck/emit and 18 tests ran remotely with no local fallback; tests require
project-relative paths and `--unstable-allow-compatible-tests-on-re`.

The mechanism is in [spec.md](./spec.md). Adoption is deferred under
[decision 0039](../.decisions/0039-namespace-first-remote-candidate-adoption-deferred.md).
Real Darwin placement remains unproved: a named workload and fully substitutable
Darwin closure are Track C's entry gate; synthetic Darwin hello is insufficient.

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
- **Per-action RE overhead (2026-09-30):** the
  [fair-concurrency rerun](../.experiments/2026-09-30-namespace-remote-execution.md#fair-concurrency-benchmark)
  took 235.276 s cold RE versus 34.668/36.053 s local; warm-worker RE with AC
  bypassed took 130.680 s. Roughly 1,100 tiny pnpm store/extract actions had
  11–12 ms median command time versus 128–132 ms median remote lifecycle time.
  That stage includes hydration/output/scheduler/transport, not measured pure
  RTT. Worker boot was about 20 s; remote runs still downloaded about 670 MiB.
  Clean-client AC reuse took 5.105 s. Track B requires local/coarsened tiny
  actions and a fair cold-latency win, or measured public CI runner queueing
  that establishes a capacity case.
