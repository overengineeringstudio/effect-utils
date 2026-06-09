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

**Body identity**:
The typed identity used to guard a page-body base. A **Rendered body identity**
names rendered Markdown bytes; an **Evidence-backed body identity** names a full
remote body observation and carries the rendered descriptor it produced.
_Avoid_: treating body identity as a generic hash.

**Rendered body identity**:
A body identity derived from the rendered Markdown descriptor only. Valid for
local desired content and local-only comparison, but not strong enough to refresh
a clean remote base when evidence is required.
_Avoid_: body hash.

**Evidence-backed body identity**:
A body identity derived from a remote body evidence fingerprint plus the rendered
body descriptor and completeness evidence. This is the only clean remote body
base identity.
_Avoid_: revision, remote truth, Notion version.

**Body projection payload**:
The durable projection value for a page body pointer, including the current
**Body identity**, body safety, and materialization metadata. It is projection
state, not raw body storage.
_Avoid_: safety JSON.

**Local desired state**:
User-authored local content and intents captured from the **Replica** and
NotionMD `.nmd` files before sync performs remote materialization or writes.
_Avoid_: treating private projections as desired state.

**Remote observation**:
A fresh Notion read of properties, lifecycle, schema, or page body state. Remote
observations update base/remote authority, not local desired state.
_Also_: Remote observed state.

**Materialization**:
Writing observed remote state into local artifacts such as `rows`, sidecars, or
`.nmd` files. Materialization is not planning and must not erase captured local
desired state.

**Guarded materialization**:
Materialization that first proves the target artifact is unchanged from base,
is this process's own write, or has had its local content preserved as a
recoverable intent/conflict.

**Replica**:
The user-facing `<database-id>.sqlite` file. Public surfaces (`rows`, `schema`,
`schema_properties`, `changes`, `conflicts`, `sync_status`, `debug_*`) plus
private `_nds_*` control plane in the same file.

**Public intent entry surface**:
The ergonomic local surface where users express row changes, usually `rows`.
Entry surfaces are validated and converted; they are not durable authority.

**Public intent ledger**:
The `changes` surface that exposes accepted local intents, planner status, and
settlement evidence to users.

**Durable local authority**:
The private append-only `_nds_*` event log that owns accepted local intent,
outbox state, conflicts, settlements, tombstones, and replay.

**Write class**:
Per-property eligibility for direct local writes: `writable`, `computed`
(read-only), or `unsupported` (fail-closed). Read visibility is broader than
write eligibility.

**Canonical synthetic live workspace**:
The deliberately synthetic Notion workspace used for live verification. Stable
IDs for its zones are configuration/environment values, not committed fixture
data.

**Durable read-only fixture**:
A stable synthetic live data source or page used for downsync, dry-run, and
sampling proof. Runtime tests observe it and prove it did not change.

**Scratch nursery**:
The dedicated live parent/area where runtime tests create disposable fixtures.
Writes are legal only for run-created objects or explicitly allowlisted scratch
page IDs.

**Provisioner lane**:
The explicit setup/repair path that creates the canonical synthetic workspace,
rotates fixture IDs, marks deliberately public synthetic fixtures, and emits the
configuration consumed by runtime verification lanes.

**Write allowlist**:
The per-run set of page, data-source, block, and ledger-region identities that a
live scenario may mutate. The remote mutation ledger must contain only
allowlisted targets.

**Ledger page marker**:
A harness-owned marker on the live Notion ledger page that bounds where status
publishing may append or replace content. Whole-page replacement is allowed only
when the harness created the page.

**Public-repository leak guard**:
The rule that public docs, issues, PRs, scenario metadata, logs, and fixtures may
include sanitized counts and deliberately synthetic labels, but not private
workspace names, private Notion IDs, raw private bodies, tokens, or signed URLs.

## Local intent and lifecycle

**Change / Intent**:
A durable user-requested local edit, recorded in `changes` (public) and backed by
a `LocalIntentAccepted` event. Accepted only after its intent event commits.

**Recoverable conflict material**:
Durable content or references sufficient to inspect, retry, resolve, or restore a
local desired state after sync detects ambiguity or conflict.

**Outbox command**:
A planned remote write derived from an accepted **Intent**, executed outside any
SQLite transaction and settled only after read-after-write verification.

**Archive**:
A reversible remote trash of a row. Reached via `UPDATE rows SET _in_trash = 1`.
Recoverable; the strongest destructive effect available through the public API.
_Avoid_: "delete" for this — see below.

**Forget**:
Drop local tracking of a row with **no remote effect**. CLI-only (`forget`); not
reachable through SQL.
_Avoid_: conflating with **Archive**.

**Delete**:
`DELETE FROM rows` is rejected. It does not map to **Archive**, local **Forget**,
or permanent deletion. There is no permanent-delete path through the API.

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
