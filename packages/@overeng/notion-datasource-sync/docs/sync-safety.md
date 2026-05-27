# Sync Safety

`notion-datasource-sync` is conservative by default. It separates authority by
surface and refuses writes when the required evidence is missing.

## Authority

| Surface                  | Source of truth while syncing           | Write rule                                            |
| ------------------------ | --------------------------------------- | ----------------------------------------------------- |
| Current remote schema    | Fresh Notion observation                | Re-read before schema-affecting writes                |
| Current row properties   | Fresh Notion row/property observation   | Re-read and hash before property patches              |
| Row page body            | `PageBodySyncPort` / NotionMD           | Delegate body conflict and destructive-body guards    |
| Local accepted intent    | SQLite event log                        | Commit event before remote effect                     |
| Pending remote effects   | SQLite outbox                           | Execute outside SQL transaction, verify settlement    |
| Local file paths         | Workspace path claims                   | Never overwrite another page's claimed path           |
| Query membership         | Query contract plus complete pagination | Never infer absence from incomplete/incompatible scan |
| Lifecycle and tombstones | Direct row/page classification          | No remote trash from accidental local disappearance   |

SQLite projections are derived state. The event log is the local source of truth
for accepted intent, conflicts, tombstones, command attempts, and settlements.

The user-facing local database is `workspace/notion.sqlite`. The internal event
log lives in `workspace/.notion-datasource-sync/store.sqlite`. Users and local
tools read current data from `notion.sqlite` and write desired data edits as
rows in typed CDC tables such as `notion_cell_changes` and
`notion_row_changes`; they do not mutate the internal store.

## Local Replica And Write Intents

`notion.sqlite` is a rebuildable replica/read-write API:

```text
Notion -> observe -> store.sqlite events -> project -> notion.sqlite
notion.sqlite intents -> plan -> outbox -> Notion -> observe -> notion.sqlite
```

The public replica has two kinds of surfaces:

| Surface                         | Write policy                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| Generic current-state tables    | Guarded current-state edits for supported cells/row lifecycle; unsafe columns are read-only |
| Generated `notion_view_*` views | Read-only ergonomic views over current rows/cells                                           |
| Typed CDC mutation tables       | Writable queues for local data edits, with base hashes and conflict policy                  |
| `notion_local_changes`          | Compatibility projection over typed mutation rows                                           |
| `notion_conflicts`              | Read-only conflict view; resolve through CLI commands                                       |

Every write intent must name the target surface, current base hash, desired
Notion-shaped value, and conflict policy. `sync --dry-run` validates these
intents and shows planned commands without mutating Notion or settling the
intents. Direct current-state edits are final-state CDC: repeated edits to the
same cell or row lifecycle target supersede earlier pending direct changes.
Normal `sync` reads pending or previously queued public changes as planner
input, performs Notion writes only after preflight reads pass, then re-reads
and projects the result back into `notion.sqlite`. A public change is not hidden
from later scans merely because it was converted to planner input.

The shipped typed CDC tables cover cells, row lifecycle/create requests, body
pushes, metadata edits, schema edits, and conflict-resolution requests. Only the
safe subset executes today: writable scalar/page-property cell patches, row
archive/restore, body pushes that pass body-adapter safety and content-hash
verification, data-source and database title/description metadata patches verified by
post-write metadata hashes, conflict-resolution choices that can be applied
through the store-backed conflict command path, and explicit row creates through
`notion_row_creates`. Row creation uses local client request keys, schema-base
guards, and durable returned `remote_page_id` settlement; ambiguous create
outcomes fail into reconciliation instead of blindly retrying. Data-source
metadata CDC is container-backed: the live adapter patches the owning database
title/description and accepts success only when a subsequent data-source
retrieval has the expected canonical metadata hash; database metadata CDC uses
the separate `notion_databases` projection and `database_id` authority while
verifying through the owning data source metadata hash. Public schema CDC rows are
recorded but fail closed from the public SQLite API until expected post-schema
hash reconciliation is modeled. Files, Notion views, destructive schema
migrations, and unsupported
conflict-resolution actions remain explicit fail-closed boundaries unless a
dedicated surface has live disposable proof.

## Establishment

The normal onboarding command is:

```sh
notion-datasource-sync sync --from-notion <data-source-id-or-url> <workspace-root>
```

Establishment has a distinct execution mode. It validates the existing Notion
data source, records the local binding, observes remote state, and materializes
remote bodies when enabled. It also creates or rebuilds `notion.sqlite` from the
observed state. It does not scan local write intents, plan local writes, enqueue
outbox commands, execute remote writes, or rebind an already configured
workspace to a different data source.

`sync --from-notion ... --dry-run` is no-write: no config file, replica file,
store events, sidecars, body files, outbox commands, or Notion mutations. For
large existing databases, add `--limit <rows>` to bound the remote preview;
capped previews are reported as incomplete and cannot be applied as partial
adoption. Established `sync <workspace-root> --dry-run` suppresses replica
mutation, event/outbox/remote writes, intent settlement, and body materialization
while still using the existing store for read-only planning.

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
- daemon lease fencing or ambiguous command settlement.

Blocked surfaces appear as guards, conflicts, tombstones, or failed outbox
attempts. They are user-visible through `status`, `doctor`, and
`conflicts list`.

## Remote Writes

Remote writes follow the same pattern:

1. Observe the relevant remote surface.
2. Compare local intent with the observed base hash.
3. Append the accepted intent and command to the local event log/outbox.
4. Execute the remote command outside the SQL transaction.
5. Re-read Notion or the body adapter.
6. Settle only when verification proves the intended state.

If the process stops after a remote attempt but before settlement, restart does
not blindly retry. It observes the current remote state and either settles the
command, retries safely, or opens an ambiguous-outcome guard.

## Query And Pagination

The query contract includes the Notion API version, filter, sorts, page size,
high-watermark, and membership scope. A complete scan advances the checkpoint
only after the terminal page is reached.

Page-property pagination is part of row observation for values that Notion may
truncate on normal page retrieval. Relation, people, title, rich text, and rollup
metadata must be fully observed or explicitly treated as incomplete.

## Body Adapter Boundary

Datasource sync treats row page bodies as a body-only surface. The
`PageBodySyncPort` may observe, plan, materialize, repair, and push body content.
It must not mutate row properties, data-source schema, lifecycle, membership, or
page metadata. Surface leaks fail closed and do not settle remote commands.

## Schema Writes

Schema changes are detected and guarded before applying row/cell intents. The
current safe subset supports explicit additive or non-destructive operations with
an expected base schema hash:

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

| Property class                              | Local replica policy                                                                                       |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Title, rich text, number, checkbox          | Writable through `notion_cells.value_json` updates or explicit `cell_patch` intents when base hash matches |
| Date, select, multi-select, status value    | Writable when option/status value semantics are fully observed and supported                               |
| URL, email, phone                           | Writable through scalar cell intents with canonical Notion-shaped JSON                                     |
| Relation                                    | Writable only for removal/reorder of fully paginated existing targets; adding new targets remains guarded until target accessibility is modeled |
| People                                      | Direct cell edits fail closed before visible mutation; requires complete page-property pagination plus deterministic accessible user identities |
| Files                                       | External URL attach is supported through explicit staging for empty files properties; direct cell edits, uploads, and replacement remain guarded |
| Formula, rollup, audit fields, unique ID    | Read-only computed values; local write intents are rejected                                                |
| `place`, unsupported or decode-drift values | Read-only/guarded until the API surface has a lossless model                                               |
| Schema/property configuration               | Guarded schema intents; destructive migrations are explicit follow-up work                                 |
| Body content                                | Delegated through NotionMD body intents and body-specific guards                                           |

Unsupported writes fail closed at intent validation or planning. They must not
be coerced into nulls, empty values, or best-effort patches.
