# Composition Open Questions

## DQ1: Do consuming members share the hub's toolchain instance pins?

- Blocks: the per-member adoption contract for the second consumer (Phase 6).
- Resolution signal: a consumer with a demonstrated need for a different
  Bun/pnpm/tsgo pin than the hub's.
- Blocker: no second consumer has adopted yet.
- Lean: share hub pins by default; parameterize through the member manifest
  `capabilities` only when a consumer proves a need (assumed 2026-08-30).
