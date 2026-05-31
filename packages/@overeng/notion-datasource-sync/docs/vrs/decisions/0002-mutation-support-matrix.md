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

### `DELETE FROM rows` maps to remote archive

`DELETE FROM rows WHERE ...` enqueues a remote **archive** (trash) intent,
identical to `UPDATE rows SET _in_trash = 1`.

- Notion trash is reversible (recoverable), so DELETE maps to the strongest
  _reversible_ remote op rather than failing closed.
- This is a deliberate choice of intuitive SQL semantics over fail-closed
  rejection, accepting Notion trash recoverability as the safety net.
- `forget` (drop local tracking, no remote effect) stays a CLI-only operation;
  it is not reachable through SQL, because DELETE now means archive.
- There is no API path to permanent deletion, so archive is the maximum
  destructive effect reachable from the file.

Requirements impact: the guard/requirement that rejected `DELETE FROM rows` must
change to "DELETE FROM rows = archive intent"; the spec's writable-subset prose
and guard matrix must be updated accordingly.

## Fail-closed cells (unchanged, documented crisply in the matrix)

people cells, file byte upload/replace/delete/preserve-existing, computed
properties (formula, rollup, audit fields, created/edited-by, unique*id,
verification), `place`, Notion view writes, relation adds of
unobserved/inaccessible targets, and any `\_nds*\*` mutation remain fail-closed
with named guards. The matrix records, per cell, the **promotion criteria**
(what proof is required to move it to supported).
