# Reuse Open Questions

## Findings from the observability lane (recorded 2026-09-25, q8)

Measured on the fleet dev host via the
[07-observability](../07-observability/spec.md) lane; the service-side fixes
are owned here and in the dotfiles service config, not in the observability
tree:

- **Synchronous action-cache upload latency:** upload p50 2.5–3.1 s per
  action (5.12 s for a 132-byte output) sits inside action spans and on the
  critical path; the check aggregate's critical action was 3.07 s queued +
  2.83 s upload + 0.003 s execute, and 622 cache queries summed 389 s.
- **Remote-CAS materialization can dominate wall time:** one materialization
  was 421.45 of 427 s wall (7,243 files / 15.6 MB at ~503 KiB/s average).
- Basis: the
  [local event-log probe](../07-observability/03-event-log-adapter/.experiments/2026-09-24-local-event-log-probe.md).
  Undetermined whether the latency is load on the fleet dev host or the cache
  service itself — needs host-side evidence before a service change.
