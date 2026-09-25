# Reuse Open Questions

## Open 2026-09-19: can portable products be reused across execution architectures?

A portable product is configured platform-invariant (`buck2/platforms/defs.bzl`), but its actions execute on an arch-specific execution platform whose toolchains are distinct Nix store paths, so its action keys differ per architecture and an aarch64 host recomputes what x86_64 already cached. Undesigned: whether portable-product outputs should be keyed by a platform-invariant action (for example a content-addressed toolchain identity) so that dev4/darwin reuse dev3's work. Until designed, BUCK-R16 records cross-architecture hit rates as informational (q39/q40, 2026-09-19).

- First measurement (S8 experiment, 2026-09-19, revision f8528ed38e): a fresh aarch64 worktree on dev4 against the dev3 cache hit 1,185 cached / 8 local actions (`package_tree`, `tsgo_typecheck`, `tsgo_emit`) — cross-architecture reuse is mostly present today, which means the execution toolchain is not in those keys; whether that is hermetic (outputs are architecture-independent JS) or a hidden input needs the design. The same revision in a same-platform sandbox with a different HOME/uid produced 633 local actions (see `.delta/2026-09-19-second-context-key-instability.md`), so host layout, not architecture, is the first key-stability problem.
- Blocked on: a design in this subsystem.
