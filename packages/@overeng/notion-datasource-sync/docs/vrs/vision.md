# Notion Datasource Sync Vision

## The Problem

**Problem 1:** Notion pages and Notion data sources are separate API surfaces. Page-body sync alone cannot represent table schema, row properties, query membership, row deletion, views, relations, or schema migration intent.

**Problem 2:** Bidirectional data-source sync can destroy data when it treats coarse page timestamps, query absence, property display names, permission failures, or local file deletion as authoritative facts.

**Problem 3:** Notion does not expose a durable ordered change stream for local-first sync. Webhooks, workers, timestamps, and queries are useful signals, but correctness still requires reconciliation against current remote state.

**Problem 4:** Agents and humans need a local SQLite replica that is usable as a data API, not only hidden client state. They need to query rows and cells locally, queue edits locally, review planned sync effects, and recover from conflicts without treating sync internals as the user database.

**Problem 5:** The existing Notion libraries in `effect-utils` solve adjacent layers, but the data-source sync concern needs a standalone primitive that composes with them instead of becoming a built-in Notion Markdown feature.

**Problem 6:** Production confidence requires live Notion verification. Schema writes, trash/restore, move semantics, pagination, filtering, permission boundaries, API-version behavior, markdown truncation, and timestamp behavior cannot be trusted from local mocks alone.

## The Vision

- Datasource sync is a standalone primitive for synchronizing Notion data sources with a user-facing local SQLite replica and a durable internal control plane.
- `<database-id>.sqlite` is the local data API. Users and tools read current data and write guarded intents there, analogous to how `@overeng/notion-md` users read and write `.nmd` files.
- The primitive composes with `@overeng/notion-md` for page-body materialization, while keeping page bodies and data-source rows as distinct sync surfaces.
- Local state is auditable and replayable. Private `_nds_*` state records history and recovery state in the same SQLite file as the public surfaces. Sync decisions are explainable, reproducible, guarded, and repairable.
- Notion remains authoritative for current remote facts after observation. Local state is authoritative for local intent, conflict records, outbox lifecycle, tombstones, path claims, and migration history.
- Every unsafe condition has a typed guard. Unknown, lossy, stale, ambiguous, or unsupported state blocks automatic writes instead of falling back to last-writer-wins behavior.
- Continuous sync uses the same correctness model as one-shot commands, so background operation cannot bypass guards.
- The Notion library stack remains composable: datasource sync uses adjacent packages without taking ownership of their domains.
- Every supported behavior has deterministic local coverage and representative live Notion E2E coverage.

## What This Is Not

- It is not a built-in feature of `@overeng/notion-md`.
- It is not a full offline Notion clone.
- It is not a last-writer-wins backup tool.
- It is not an automatic destructive schema migration tool.
- It is not a replacement for Notion permissions, ownership, or workspace policy.
- It is not dependent on Notion Workers, webhooks, or any hosted callback path for correctness.
- It is not a generic relational database replicator for arbitrary SQL schemas.
- It is not a promise that every object inside `<database-id>.sqlite` is public API; `_nds_*` remains private implementation state.

## Success Criteria

1. A user can bind a Notion data source to a local workspace, inspect schema and rows through `<database-id>.sqlite`, edit supported local data through public SQLite surfaces and page-body files, and push changes without mixing body metadata into data-source state.
2. Local control-plane state can be replayed to rebuild derived sync state deterministically.
3. A normal sync refuses stale, ambiguous, lossy, or unsupported writes and reports the exact guard that blocked the operation.
4. Disjoint local and remote edits merge automatically at the smallest safe sync surface; same-surface edits become durable conflicts with explicit resolution commands.
5. Schema changes are detected and guarded through property-ID-aware planning. Safe additive schema edits can be explicit intents; destructive or rich schema migrations require follow-up migration workflows with impact reports.
6. Trash, restore, move-out, move-back, permission loss, and query absence are classified by direct retrieval before any destructive decision.
7. Continuous local sync can run for long periods, recover after interruption, honor rate limits, avoid concurrent writers, and repair missed changes.
8. `@overeng/notion-md` can be used as a page-body adapter without depending on datasource-sync internals.
9. The package ships with unit, fake-service integration, SQLite replay, filesystem, daemon, telemetry, and live Notion E2E tests covering the guard matrix.
