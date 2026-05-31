# E2E Plan

This companion plan names scenario families that are broader than one test file.
Normative requirements live in [requirements.md](./requirements.md) and the
implementation blueprint lives in [spec.md](./spec.md).

## Bidirectional Safety Suite

Bidirectional sync is verified by scenario families, not by isolated guard
checks. Every scenario row must define:

- the initial remote and replica state,
- the local SQLite or filesystem action,
- the remote Notion action,
- the expected remote mutation ledger,
- the expected private store state,
- the expected public `rows`, `changes`, `conflicts`, and `sync_status`
  projection,
- the rebuild/replay assertion when the scenario changes durable state.

The typed source of truth for the suite is
`src/testing/bidi-safety.ts`. `src/testing/scenarios.ts` registers each scenario
with requirement and guard metadata, and the fake-service metadata test asserts
that every bidi-safety row has a registered scenario ID.

| Scenario                                              | Tier    | Risk             | Required proof                                                                                     |
| ----------------------------------------------------- | ------- | ---------------- | -------------------------------------------------------------------------------------------------- |
| `NDS-L4-bidi-clean-outbound-after-remote-observation` | replica | false conflict   | clean observations advance local bases unless an unresolved local intent pins the property surface |
| `NDS-L4-bidi-same-property-race-conflict`             | replica | lost update      | same-property races open durable conflicts and issue no stale remote patch                         |
| `NDS-L4-bidi-disjoint-property-merge`                 | replica | lost update      | disjoint local and remote property edits merge without rollback                                    |
| `NDS-L4-bidi-archive-edit-race`                       | replica | silent delete    | lifecycle/edit races fail closed and never infer remote trash from ambiguity                       |
| `NDS-L6-bidi-body-local-capture-first`                | live    | local overwrite  | established `sync` captures changed `.nmd` before remote body materialization can overwrite it     |
| `NDS-L5-bidi-watermark-boundary-overlap`              | daemon  | missed inbound   | incremental polling drains whole `last_edited_time` boundary buckets before checkpoint advance     |
| `NDS-L5-bidi-incremental-absence-not-tombstone`       | daemon  | silent delete    | high-watermark omissions create no absence or tombstone evidence                                   |
| `NDS-L5-bidi-relation-pagination-scoped-block`        | daemon  | global wedge     | incomplete property pagination blocks the affected property, not the whole root                    |
| `NDS-L3-bidi-ambiguous-write-idempotency`             | fake    | duplicate write  | ambiguous retries reconcile by observation without duplicate remote mutation                       |
| `NDS-L4-bidi-conflict-resolution-lifecycle`           | replica | stale projection | supported resolutions retire active local changes while preserving audit history                   |
| `NDS-L4-bidi-rebuild-replay-safety`                   | replica | stale projection | replay preserves tombstones, conflicts, terminal changes, and pinned property bases                |
| `NDS-L5-bidi-local-first-slow-pull`                   | daemon  | stale projection | eligible local CDC is pushed before slow remote pull completion                                    |
| `NDS-L5-bidi-inline-hydration-correctness`            | daemon  | missed inbound   | inline query-row values preserve hashes and avoid unnecessary per-row page reads                   |
| `NDS-L6-tasks-tracker-read-only-downsync`             | live    | user data loss   | existing Tasks Tracker rows are observed/downsynced without any Notion mutation                    |
| `NDS-L6-tasks-tracker-scratch-row-bidi`               | live    | user data loss   | one allowlisted scratch row proves SQLite property, `.nmd` body, and lifecycle bidi behavior       |

## Live Safety Envelope

Live Notion bidi tests may mutate only disposable rows or data sources created
by the test run. They must record fixture IDs in the cleanup ledger, archive
fixtures during cleanup, and assert the Notion mutation ledger before accepting a
scenario as passed. Real user database tests remain read-only/downsync unless a
separate disposable fixture plan is approved.

Conflict, stale-base, archive, and ambiguous-outcome scenarios must assert that
no remote mutation was attempted when the safety precondition failed. Passing by
ending in the right local projection is insufficient.

Tasks Tracker live verification has two modes:

- `NDS-L6-tasks-tracker-read-only-downsync` samples existing non-scratch rows,
  records `page_id`, `last_edited_time`, `in_trash`, and selected stable
  properties, runs the read-only/downsync command path, then proves those rows
  are unchanged by direct Notion reads and an empty mutation ledger.
- `NDS-L6-tasks-tracker-scratch-row-bidi` creates or uses exactly one row whose
  title contains a unique run marker. The harness records its `page_id`, scopes
  every SQL write with `WHERE _page_id = <scratchPageId>`, allowlists only that
  `page_id` for Notion writes, snapshots non-scratch rows before/after, and
  fails if any non-scratch sampled row changes.

Tasks Tracker live tests must never run broad `UPDATE rows`, broad `DELETE`,
archive, restore, body materialization, or cleanup against existing non-scratch
rows. Destructive lifecycle scenarios belong in disposable data sources unless
the Tasks Tracker target is the single allowlisted scratch row.

## No-Data-Loss Acceptance

The no-data-loss suite is accepted only when these checks pass:

- established `sync`, `push`, and `sync --watch` capture SQLite `rows`/`changes`
  and `.nmd` bodies before local materialization that could overwrite them,
- accepted local intent is visible in the public `changes` ledger and backed by
  private `_nds_*` events; malformed or unsupported writes fail atomically,
- remote observations may advance base/remote projections, open conflicts, or
  prove intent landed, but must not drop, hide, or mutate pending local target
  state,
- remote writes execute only from committed outbox commands after fresh preflight
  reads and settle only after read-after-write verification,
- `.nmd` materialization writes only when the target is unchanged from captured
  base or was this process's own materialization; changed, uncaptured,
  ambiguous, or path-colliding bodies are preserved as conflict/repair material,
- `DELETE FROM rows` means reversible Archive only; it never means Forget or
  permanent deletion, and bare filesystem deletion remains candidate-only,
- rebuild/replay preserves pending intents, conflicts, tombstones, settlements,
  hashes, public visibility, and recoverable conflict material,
- every scenario asserts remote mutation ledger, private store, public replica,
  and rebuild/replay where durable state changes.

## Promotion Rule

Each bidi scenario starts at the lowest tier that can prove the invariant:

- fake gateway for pure planner, outbox, retry, and call-ledger behavior,
- replica E2E for public SQLite triggers, CDC settlement, rebuild, and user
  observability,
- daemon E2E for checkpoint reuse, scheduling, local-first latency, and repair
  scans,
- live Notion E2E only for API semantics that fake services cannot prove.

A bug found live must be reduced into the lowest deterministic tier that would
have caught it, then optionally retained as a live smoke if it depends on Notion
API behavior.
