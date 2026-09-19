# Reuse Open Questions

## Open 2026-09-19: can portable products be reused across execution architectures?

A portable product is configured platform-invariant (`buck2/platforms/defs.bzl`), but its actions execute on an arch-specific execution platform whose toolchains are distinct Nix store paths, so its action keys differ per architecture and an aarch64 host recomputes what x86_64 already cached. Undesigned: whether portable-product outputs should be keyed by a platform-invariant action (for example a content-addressed toolchain identity) so that dev4/darwin reuse dev3's work. Until designed, BUCK-R16 records cross-architecture hit rates as informational (q39/q40, 2026-09-19).

- Blocked on: a design in this subsystem; the first measurement is the dev4 informational run scheduled with the q40 sandbox experiment.
