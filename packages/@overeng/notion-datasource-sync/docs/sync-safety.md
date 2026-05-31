# Sync Safety

`notion-datasource-sync` is conservative by default. It separates public data
surfaces from private sync state and refuses writes when required evidence is
missing.

## Authority

| Surface                  | Source of truth while syncing                | Write rule                                          |
| ------------------------ | -------------------------------------------- | --------------------------------------------------- |
| Current remote schema    | Fresh Notion observation                     | Re-read before schema-affecting writes              |
| Current row properties   | Fresh Notion row/property observation        | Re-read and hash before property patches            |
| Row page body            | `PageBodySyncPort` / NotionMD                | Delegate body conflict and destructive-body guards  |
| Local accepted intent    | `_nds_*` event log in the database file      | Commit event before remote effect                   |
| Pending remote effects   | `_nds_*` outbox in the database file         | Execute outside SQL transaction, verify settlement  |
| Local file paths         | Workspace path claims                        | Never overwrite another page's claimed path         |
| Query membership         | Full database query plus complete pagination | Never infer absence from incomplete or capped scans |
| Lifecycle and tombstones | Direct row/page classification               | No remote trash from accidental local disappearance |

Each Notion database has one self-contained SQLite file:
`<workspace>/<database-id>.sqlite`. Public local surfaces are `rows`, `schema`,
`schema_properties`, `changes`, `conflicts`, and `sync_status`. Debug views are
read-only `debug_*` views. Private sync-control tables are `_nds_*`.

The `_nds_*` tables are the local source of truth for accepted intent,
conflicts, tombstones, command attempts, settlements, checkpoints, and integrity
digests. They are not user-editable. If private state is corrupt, missing, or
tampered with, `doctor` fails closed and sync does not infer remote writes from
public row content alone.

## Local Replica And Write Intents

The database file is a rebuildable read/write API and the private control plane:

```text
Notion -> observe -> _nds_* events/projections -> public rows/schema/debug views
public rows/changes -> validate -> _nds_* outbox -> Notion -> observe -> public rows
```

`rows` is the primary writable product API. It exposes current-state Notion row
data as ordinary SQLite columns while preserving guarded CDC semantics under the
hood. The other stable public surfaces are for observation and user action:
`changes` explains accepted or blocked local intent, `conflicts` exposes
conflict records, and `sync_status` exposes health and pending-work state.

Public surfaces:

| Surface                        | Write policy                                                                |
| ------------------------------ | --------------------------------------------------------------------------- |
| `rows`                         | Guarded current-state edits, row inserts, and `_in_trash` lifecycle intents |
| `schema` / `schema_properties` | Read-only binding and property-to-column mapping                            |
| `changes`                      | Guarded public edit-intent and status surface                               |
| `conflicts`                    | Read-only conflict view; resolve through CLI commands                       |
| `sync_status`                  | Read-only health, guard, checkpoint, and pending-work view                  |
| `debug_*`                      | Read-only diagnostics over canonical JSON, hashes, outbox, and projections  |
| `_nds_*`                       | Private implementation state; direct edits are unsupported                  |

Every write intent must resolve to a target property/lifecycle surface, current
base hash, desired Notion-shaped value, and conflict policy. `rows` hides the
canonical JSON for ordinary scalar edits, but it does not bypass `changes`,
private `_nds_*` intent capture, or outbox verification. `sync --dry-run`
validates these intents and shows planned commands without mutating Notion or
settling the intents.

Direct current-state edits are final-state CDC: repeated edits to the same cell
or row lifecycle target supersede earlier pending direct changes. Normal `sync`
reads pending public changes, performs Notion writes only after preflight reads
pass, then re-reads and projects the result back into the same SQLite file. A
public change is not hidden from later scans merely because it was converted to
planner input.

`sync --watch` mode has the same local CDC obligation as one-shot sync. Each daemon
cycle must read pending `rows` / `changes` state from established
`<database-id>.sqlite` files, plan safe remote effects, execute verified
commands, and update public observability. Remote polling, repair scans, and
retry timers are additions to that contract, not replacements for local SQLite
CDC processing.

## Establishment

The normal onboarding command is:

```sh
notion-datasource-sync sync --from-notion <data-source-id-or-url> <workspace-root>
```

Establishment validates the existing Notion database/data source, creates
`<workspace>/<database-id>.sqlite`, records the binding inside `_nds_*`, observes
remote state, projects public tables, and materializes remote bodies when
enabled. It does not scan local write intents, plan local writes, enqueue outbox
commands, execute remote writes, or rebind an already established database file
to a different Notion database.

`sync --from-notion ... --dry-run` is no-write: no SQLite database file, body
files, outbox commands, or Notion mutations. For large existing databases, add
`--limit <rows>` to bound the remote preview; capped previews are reported as
incomplete and cannot be applied as partial adoption. Established
`sync <workspace-root> --dry-run` suppresses public table mutation, private
event/outbox writes, remote writes, intent settlement, and body materialization
while still using existing state for read-only planning.

## Fail-Closed Boundaries

The package blocks instead of guessing when it sees:

- unsupported Notion API version or decode drift,
- missing integration capability,
- incomplete query pagination,
- incomplete page-property pagination,
- unshared relation or rollup inputs,
- computed property writes,
- destructive schema migrations,
- stale schema or property base hashes,
- body adapter conflicts, truncation, unknown blocks, or surface leaks,
- ambiguous 403/404 permission outcomes,
- file-byte identity that cannot be proven,
- direct writes to `_nds_*` or `debug_*`,
- private-state digest, migration, or checkpoint mismatch,
- daemon lease fencing or ambiguous command settlement.

Blocked surfaces appear as guards, conflicts, unsupported changes, tombstones,
or failed outbox attempts. They are user-visible through `sync_status`, `status`,
`doctor`, and `conflicts list`.

## Remote Writes

Remote writes follow the same pattern:

1. Observe the relevant remote surface.
2. Compare local intent with the observed base hash.
3. Append the accepted intent and command to private `_nds_*` state.
4. Execute the remote command outside the SQLite transaction.
5. Re-read Notion or the body adapter.
6. Settle only when verification proves the intended state.

If the process stops after a remote attempt but before settlement, restart does
not blindly retry. It observes the current remote state and either settles the
command, retries safely, or opens an ambiguous-outcome guard.

## Query And Pagination

Product replicas use full database membership: no filter, no sort, page size
`100`, and no user-visible high-watermark. Watch mode may add an internal
inclusive high-watermark filter for steady-state polling; that filter is a scan
window, not product membership identity. A complete scan advances the private
checkpoint only after the terminal page is reached. Dry-run limits are capped
previews and do not establish or update `<database-id>.sqlite` replicas.

Page-property pagination is part of row observation for values that Notion may
truncate on normal page retrieval. Relation, people, title, rich text, and rollup
metadata must be fully observed or explicitly treated as incomplete.

## Body Adapter Boundary

Datasource sync treats row page bodies as a body-only surface. The
`PageBodySyncPort` may observe, plan, materialize, repair, and push body
content. It must not mutate row properties, data-source schema, lifecycle,
membership, or page metadata. Surface leaks fail closed and do not settle remote
commands.

## Schema Writes

Schema changes are detected and guarded before applying row/cell intents. The
current safe subset supports explicit additive or non-destructive operations
with an expected base schema hash:

- add property,
- rename property,
- add select options,
- add multi-select options.

Unsupported schema operations include property deletion, type conversion,
destructive option replacement/removal, automatic status updates, and broad
schema convergence without an explicit app-owned policy.

Rich schema migration workflows are follow-up work. Until then, schema drift
that affects pending local intents opens a conflict or guard instead of
rewriting local values or applying broad migrations.

## Property Write Matrix

| Property class                              | Local replica policy                                                                                                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Title, rich text, number, checkbox          | Writable through `rows` updates when base hash matches                                                                                                                  |
| Date, select, multi-select, status value    | Writable when option/status value semantics are fully observed and supported                                                                                            |
| URL, email, phone                           | Writable through scalar cell intents with canonical Notion-shaped JSON                                                                                                  |
| Relation                                    | Writable for remove/reorder/add from fully paginated bases when each added target is already observed in `debug_*` relation diagnostics; unobserved targets fail closed |
| People                                      | Direct cell edits fail closed before visible mutation; requires complete page-property pagination plus deterministic accessible user identities                         |
| Files                                       | External URL attach is supported through explicit staging for empty files properties; direct cell edits, uploads, and replacement remain guarded                        |
| Formula, rollup, audit fields, unique ID    | Read-only computed values; local write intents are rejected                                                                                                             |
| `place`, unsupported or decode-drift values | Read-only/guarded until the API surface has a lossless model                                                                                                            |
| Schema/property configuration               | Guarded schema intents; destructive migrations are explicit follow-up work                                                                                              |
| Body content                                | Delegated through NotionMD body intents and body-specific guards                                                                                                        |

Unsupported writes fail closed at intent validation or planning. They must not
be coerced into nulls, empty values, or best-effort patches.
