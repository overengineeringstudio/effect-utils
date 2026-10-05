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

## BUILD.BUCK.REUSE-DQ01: Lane budget values

[Spec](./spec.md#open-design-questions). Blocked on honest measurements for
edit-run, quick check, full tests and platform/host proof. No numbers are invented.

## BUILD.BUCK.REUSE-DQ02: Writer attribution and purge integration

[Spec](./spec.md#open-design-questions). Consumer/service owners must specify
revocable per-host keys, authenticated write-key logging, quarantine and targeted
AC purge. The public lane eligibility contract is not an authorization mechanism.

## BUILD.BUCK.REUSE-DQ03: Product descriptor reuse

[Spec](./spec.md#open-design-questions). Measured 2026-10-05 with
`scripts/buck2-remote-cache-proof.sh` (two roots, loopback cache) at the
[#1616](https://github.com/overengineeringstudio/effect-utils/pull/1616#issuecomment-5987277977)
head: the test half passes with 192 remote hits and no local work, but the build
half on root B runs 581 remote hits and exactly one local
`javascript_product_descriptor` action (`buck2/products/defs.bzl`, declared
`local_only`). The action stays default-denied for cache reads. Undetermined:
whether its output is root-independent enough to share (its provenance embeds the
configured target label), or whether the proof should exempt local-only actions.
