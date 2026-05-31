# User-facing mutation support matrix

Status: accepted

The user-facing contract for "what can I do to `<database-id>.sqlite`" is
captured as a single matrix keyed by **SQL operation**, distinct from the
Notion-API-surface view. Both live in `capability-gaps.md`:

- `## By API surface` — existing release-readiness view keyed by Notion API.
- `## By SQL operation` — new user-facing view keyed by the SQL the user writes.

The two sections are cross-linked. The SQL-operation section is the single
source of truth for user-facing write support; it must agree with the
`replica-api` and `schema-migration` sub-system specs.

## Decisions captured here

### Schema changes are CLI-only

Additive schema changes (add property, rename property, add select/multi-select
options) are expressed only through `migrate schema --plan/--apply`. There is no
SQLite write path for schema:

- `schema` and `schema_properties` are read-only in the file.
- `ALTER TABLE rows ...` (DDL) is rejected.
- `kind=schema` rows in the public `changes` table are rejected;
  `NotionSchemaChange` is not a public write intent.
- The file may surface a read-only migration **preview** (in `sync_status` /
  `debug_*`); apply happens via CLI.

Destructive schema migrations (delete property, type conversion, option
removal/rename, status option/group changes, property reorder) remain CLI-only
and require an impact report. See [[0003-schema-migration-cli-only]].

Rationale: keeps property-ID identity authoritative, avoids hidden DDL-trigger
semantics (SQLite has no DDL triggers), and keeps schema migration's two-phase
plan/apply auditable.

### SQL row delete is not a remote lifecycle command

`DELETE FROM rows WHERE ...` is rejected by the public replica.

- Archive and restore are explicit `_in_trash` edits.
- `forget` drops local tracking with no remote effect and stays CLI-only.
- There is no API path to permanent deletion, and SQL delete must not be
  overloaded to mean local forget, remote archive, or permanent removal.

## Fail-closed cells (unchanged, documented crisply in the matrix)

people cells, file byte upload/replace/delete/preserve-existing, computed
properties (formula, rollup, audit fields, created/edited-by, unique*id,
verification), `place`, Notion view writes, relation adds of
unobserved/inaccessible targets, and any `\_nds*\*` mutation remain fail-closed
with named guards. The matrix records, per cell, the **promotion criteria**
(what proof is required to move it to supported).
