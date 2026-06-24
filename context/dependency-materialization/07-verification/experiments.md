# Dependency Materialization Verification Experiments

This file records non-normative evidence for dependency materialization
verification. Normative behavior lives in [spec.md](./spec.md).

## 2026-06-24: dotfiles PR #1126 Consolidation Review

Hypothesis:

- `schickling/dotfiles#1126` should be closed after its durable proof categories
  are represented in the effect-utils DMP VRS.

Source:

- `schickling/dotfiles#1126`, draft PR titled
  `research(buck2): prototype dependency profile evidence`.

Result:

- The draft PR contains valuable proof categories: split shared-CAS prune
  failure, `pnpm store status` false-clean evidence, doctor/repair models,
  store-trait benchmarks, profile evidence determinism, FOD freshness, native
  lifecycle/source-build probes, CI job-local isolation, low-disk skips, and
  Buck2 clean-root/profile evidence.
- Those categories map cleanly to existing effect-utils DMP subsystems:
  store authority, Nix prepared deps, Buck2 evidence, observability, and this
  verification subsystem.
- The old PR also contains dotfiles-owned VRS/prototype files that should not
  remain the source of truth after the VRS migration.

Conclusion:

- Close dotfiles PR #1126 as superseded by effect-utils PR #829.
- Keep the reusable long-term shape in effect-utils as the verification
  subsystem and referenced evidence categories, not as a dotfiles pointer.
