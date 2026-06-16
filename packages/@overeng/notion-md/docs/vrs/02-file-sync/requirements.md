# Requirements: 02-file-sync

**Role.** The file-based sync surface and its orchestration: the pull / status /
push flows over a persistent `.nmd` file, watch-mode lifecycle, and the
batch/tree orchestrator (target discovery, duplicate page-id preflight, bounded
concurrency, per-file results). One `.nmd` file maps to one Notion page; every
mutation passes through the shared page-local guards in
[03-sync-engine](../03-sync-engine/requirements.md).

Builds on the cross-cutting [../requirements.md](../requirements.md) (global
A/T) and [../glossary.md](../glossary.md). IDs are GLOBAL and preserved. The
guarded-push / three-way-merge / settle engine this surface calls is owned by
[03-sync-engine](../03-sync-engine/requirements.md) (R09, R11, R13, R15); the
file/property-surface bits of R11/R13 are exercised here but defined there.

## Requirements

### Must coordinate file-based sync safely

- **R20 Bounded concurrency:** Watch mode must serialize or intentionally coordinate sync passes so local writes, remote writes, and state-store updates cannot overlap unsafely.

### Must verify watch behavior

- **R28 Watch coverage:** Watch mode must be tested for debounce, coalescing, cancellation, overlapping events, remote polling, and shutdown.
