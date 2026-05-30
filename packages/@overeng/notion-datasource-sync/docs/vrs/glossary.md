# Notion Datasource Sync — Glossary

Domain language for the Notion data-source ↔ local SQLite sync primitive. Covers
terms whose meaning is load-bearing for correctness and easily conflated.

## Notion model

**Data source**:
The schema and row-query boundary in Notion. Properties, row membership, and
schema migrations are defined here. This is the table identity for sync.
_Avoid_: table, collection.

**Database**:
A Notion container that holds one or more **Data sources**. It carries
container-level metadata (title, icon, cover, parent, inline state) but is not
the schema/row identity.
_Avoid_: using "database" to mean the row table — that is the **Data source**.

**Property ID**:
The stable identifier for a **Data source** property. Authoritative for hashing,
planning, conflict detection, and settlement. Survives renames.
_Avoid_: treating the display **name** as identity.

**View**:
A Notion display configuration (filter/sort/layout) over a **Data source**. Never
row-membership or deletion authority; projected read-only as `debug_*`.

## Sync surfaces and identity

**Surface**:
The smallest independently-hashed unit a write targets — a single property value,
a page body, or the schema. Conflicts and base hashes are per-surface.

**Base hash**:
The last-clean canonical hash of a **Surface** that a local edit was made
against. A write is only safe if the current remote surface still matches it.

**Replica**:
The user-facing `<database-id>.sqlite` file. Public surfaces (`rows`, `schema`,
`schema_properties`, `changes`, `conflicts`, `sync_status`, `debug_*`) plus
private `_nds_*` control plane in the same file.

**Write class**:
Per-property eligibility for direct local writes: `writable`, `computed`
(read-only), or `unsupported` (fail-closed). Read visibility is broader than
write eligibility.

## Local intent and lifecycle

**Change / Intent**:
A durable user-requested local edit, recorded in `changes` (public) and backed by
a `LocalIntentAccepted` event. Accepted only after its intent event commits.

**Outbox command**:
A planned remote write derived from an accepted **Intent**, executed outside any
SQLite transaction and settled only after read-after-write verification.

**Archive**:
A reversible remote trash of a row. Reached via `UPDATE rows SET _in_trash = 1`
or `DELETE FROM rows`. Recoverable; the strongest destructive effect available
through the public API.
_Avoid_: "delete" for this — see below.

**Forget**:
Drop local tracking of a row with **no remote effect**. CLI-only (`forget`); not
reachable through SQL.
_Avoid_: conflating with **Archive**.

**Delete**:
`DELETE FROM rows` — maps to **Archive** (remote trash), not local **Forget** and
not permanent deletion. There is no permanent-delete path through the API.

**Tombstone**:
A classification of a row absent from the query, resolved by direct page
retrieval into trashed / moved-out / moved-between-tracked-sources / inaccessible
/ unknown. Query absence alone is never deletion evidence.

**Move-out**:
A page whose parent left the tracked **Data source**. Preserves local artifacts;
never triggers remote trash.

## Control plane

**Event**:
An immutable, append-only record of an observation or accepted intent. The
authoritative local history.

**Projection**:
A disposable, rebuildable view derived from **Events**. Dropping all projections
and replaying events must reproduce identical digests.

**Lease**:
The single-writer token for a sync root. Stale leases are fenced and cannot
settle commands.
