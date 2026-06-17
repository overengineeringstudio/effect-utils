# Notion DB Markdown Sync — Glossary

This glossary fixes the language for exploring a Markdown-folder surface for
Notion data-source pages. It is scoped to datasource sync composition; page-body
Markdown terms remain owned by NotionMD.

## Language

**Data source**:
The Notion schema and row-query boundary. A database may contain or expose a
data source, but the data source is the table identity.
_Avoid_: Database when referring to schema/query identity.

**Linked view**:
A Notion view or linked database presentation over an existing **Data source**.
It does not own page files, SQL data files, schema, deletion, or remote writes.
_Avoid_: Linked data source as a tracked source unless the API exposes a real
data-source identity.

**Page file**:
A `.nmd` Markdown file representing one Notion page that belongs to a data
source. It follows the standalone NotionMD envelope: strict JSON frontmatter
under `notion_md`, plus stock Notion enhanced Markdown body content.
_Avoid_: Row file in user-facing docs.

**Row**:
The internal datasource-sync term for a queried data-source item when planning
property/lifecycle sync. A row corresponds to a Notion page, but `row` should
not be the Markdown workspace term.
_Avoid_: Page when discussing internal tabular planning.

**User surface**:
A local artifact users are expected to read or write directly. The canonical
user surfaces are the SQLite data file and page files.
_Avoid_: Interface, target.

**Implementation state**:
Hidden local state used for safety, replay, planning, materialization,
own-write suppression, and repair. Users do not edit it directly.
_Avoid_: User sidecar, metadata file.

**Markdown surface**:
A `pages/v1/**/*.nmd` user surface backed by hidden implementation state. It is not
the sync-control store.
_Avoid_: Markdown database, folder database.

**Sync-control store**:
The durable SQLite state that owns events, bases, outbox, conflicts,
checkpoints, leases, and accepted local intents. It lives under hidden
implementation state, not in the user-facing data-file API.
_Avoid_: Cache, sidecar.

**Data file**:
The user-facing SQLite file for one tracked **Data source**, conventionally
`data/v1/<source-name>.sqlite` in v1 workspaces. It exposes only stable
public tables/views and contains no private sync-control tables.
_Avoid_: Store, control plane.

**Workspace namespace version**:
The explicit version boundary for durable local artifacts, carried by paths,
file names, SQLite metadata, and file-format/schema identifiers. Unknown or
mixed namespace versions fail closed instead of being migrated implicitly.
_Avoid_: per-file mode, alternate public table name.

**Authority mode**:
The workspace-level source of authority: `local`, `remote`, or `shared`. It is
inherited by both data files and `pages/v1/**/*.nmd`; the two user surfaces do not
declare independent conflicting modes.
_Avoid_: Direction flag, push/pull mode.

**Page-file sidecar**:
Hidden implementation state for a page file, keyed by page ID and rebuildable
from datasource-sync state.
_Avoid_: Sync store, replica.

**Property mutation proof**:
The evidence required before a datasource-scoped property edit may become local
intent: stable property identity, fresh schema mapping, relation target
availability when relevant, and no disagreement between local user surfaces.
_Avoid_: Standalone permission, CLI permission.

**Property descriptor**:
A compact, non-authoritative identity hint in a page file that records which
Notion property a visible field claims to edit. It may include property ID,
name, type, data-source ID, and config hash, but it is not freshness or
convergence proof.
_Avoid_: Base, sync proof.

**Property write core**:
The shared semantic guard that validates property mutation proof and returns an
allow/block decision. It depends on canonical property schemas and codecs, but
does not fetch live state or own workspace sync policy.
_Avoid_: Sync engine, CLI handler.

**Proof provider**:
A component that supplies evidence to the **Property write core**. Standalone
NotionMD can provide live page/schema evidence; datasource-sync can provide
workspace convergence, outbox, conflict, and settlement evidence.
_Avoid_: Adapter when discussing evidence semantics.

## Flagged Ambiguities

**Sync target**:
Can mean export format, projection surface, writable local intent surface, or
authoritative replica. For this exploration, use the precise term instead of
`target` unless discussing CLI flags.
