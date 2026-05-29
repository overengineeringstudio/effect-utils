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
| `NDS-L5-bidi-watermark-boundary-overlap`              | daemon  | missed inbound   | incremental polling drains whole `last_edited_time` boundary buckets before checkpoint advance     |
| `NDS-L5-bidi-incremental-absence-not-tombstone`       | daemon  | silent delete    | high-watermark omissions create no absence or tombstone evidence                                   |
| `NDS-L5-bidi-relation-pagination-scoped-block`        | daemon  | global wedge     | incomplete property pagination blocks the affected property, not the whole root                    |
| `NDS-L3-bidi-ambiguous-write-idempotency`             | fake    | duplicate write  | ambiguous retries reconcile by observation without duplicate remote mutation                       |
| `NDS-L4-bidi-conflict-resolution-lifecycle`           | replica | stale projection | supported resolutions retire active local changes while preserving audit history                   |
| `NDS-L4-bidi-rebuild-replay-safety`                   | replica | stale projection | replay preserves tombstones, conflicts, terminal changes, and pinned property bases                |
| `NDS-L5-bidi-local-first-slow-pull`                   | daemon  | stale projection | eligible local CDC is pushed before slow remote pull completion                                    |
| `NDS-L5-bidi-inline-hydration-correctness`            | daemon  | missed inbound   | inline query-row values preserve hashes and avoid unnecessary per-row page reads                   |

## Live Safety Envelope

Live Notion bidi tests may mutate only disposable rows or data sources created
by the test run. They must record fixture IDs in the cleanup ledger, archive
fixtures during cleanup, and assert the Notion mutation ledger before accepting a
scenario as passed. Real user database tests remain read-only/downsync unless a
separate disposable fixture plan is approved.

Conflict, stale-base, archive, and ambiguous-outcome scenarios must assert that
no remote mutation was attempted when the safety precondition failed. Passing by
ending in the right local projection is insufficient.

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
