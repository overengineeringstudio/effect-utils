# 2026-06-24: dotfiles PR #1126 Consolidation Review

This file records non-normative evidence for dependency materialization
verification. Normative behavior lives in
[../spec.md](../spec.md).

## Hypothesis

`schickling/dotfiles#1126` can be closed after its durable proof categories are
represented in the effect-utils DMP VRS.

## Source

`schickling/dotfiles#1126`, draft PR titled
`research(buck2): prototype dependency profile evidence`.

## Result

The draft PR contains valuable proof categories:

- split shared-CAS prune failure;
- `pnpm store status` false-clean evidence;
- doctor and repair models;
- store-trait benchmarks;
- profile evidence determinism;
- FOD freshness;
- native lifecycle and source-build probes;
- CI job-local isolation;
- low-disk skips;
- Buck2 clean-root and profile evidence.

Those categories map cleanly to existing effect-utils DMP subsystems:

| Durable category                       | Owning VRS surface                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| shared-store prune/status/repair       | [04-store-authority](../../04-store-authority/spec.md)                             |
| prepared FOD freshness and hash proof  | [03-nix-prepared-deps](../../03-nix-prepared-deps/spec.md)                         |
| Buck2 clean-root/profile evidence      | [05-buck2-evidence](../../05-buck2-evidence/spec.md)                               |
| benchmarks, skips, and proof taxonomy  | [07-verification](../spec.md)                                                      |
| build-log and machine-readable records | [06-observability](../../06-observability/spec.md)                                 |

The old PR also contains dotfiles-owned VRS/prototype files that should not
remain the source of truth after the VRS migration.

## Conclusion

Close dotfiles PR #1126 as superseded by effect-utils PR #829.

Keep the reusable long-term shape in effect-utils as verification requirements,
fixtures, reusable proof harnesses, benchmark records, and pending evidence
markers, not as a dotfiles-owned VRS pointer.
