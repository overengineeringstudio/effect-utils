# Control-plane file split: hidden state.sqlite vs public data file

Status: proposed

The workspace SQLite layout splits into two files (Phase 4 SM3):

- `data/v1/<source>.sqlite` — the public product surface: writable `pages`,
  read-only `changes`/`conflicts`/`sync_status`/`schema`/`schema_properties`/`debug_*`,
  and the `_nds_replica_*` projection cache that backs them.
- `.notion/v1/state.sqlite` — the hidden control plane: the event log
  (`_nds_sync_event`), outbox, guard blocks, tombstones, capabilities, conflicts,
  checkpoints, bases, objects refs, and the `_nds_workspace_binding`.

Both files are standalone-queryable: neither ATTACHes the other at query time.

## DD-A: scope of "no public `_nds_*`" is control-plane only

"No `_nds_*` in the public data file" means no CONTROL-PLANE `_nds_*`. The
`_nds_replica_*` projection tables are a rebuildable read-model CACHE and STAY in
the data file: they back the dynamic-column `pages` view and are the sanctioned
read surface behind `debug_*`. Deleting the data file rebuilds losslessly for
_settled_ state — `projectReplicaFromSyncStore` reconstructs the entire
`_nds_replica_*` cache and the public views from the event log in state.sqlite.
The one exception: a local edit lives only in the data file's transient
`_nds_replica_*_changes` CDC inbox until a `sync`/`push` drains it into the
state.sqlite event log, so deleting the data file with un-drained edits loses
those edits. Drain first (`sync`/`push`) for a clean disposal. (A future
refinement could make the data file truly disposable by draining the CDC inbox
into state.sqlite synchronously or on next open — recorded as a follow-up.)

The public-surface contract test asserts this invariant directly: every `_nds_*`
object in the data file is `_nds_replica_*` (or a public `_nds_pages_*` CDC
trigger), and none of the control-plane tables defined in `store/schema.ts`
appear.

## DD-B: sync_status materializes control-plane counts at projection time

The `sync_status` and `schema` views previously read control-plane tables
(`_nds_outbox`, `_nds_guard_block`, `_nds_tombstone`, `_nds_capability`,
`_nds_query_scan_checkpoint`, `_nds_page_property_checkpoint`,
`_nds_workspace_binding`) directly. After the split those tables are in a
different file, which a standalone data-file query cannot reach.

Resolution: the projector reads those control-plane tables from state.sqlite at
projection time and MATERIALIZES the results into the data file's projection
tables:

- Control-plane aggregate counts (`pending_outbox`, `blocked_outbox`,
  `guard_blocks`, `unclassified_tombstones`, `unsupported_capabilities`,
  `incomplete_hydration`) materialize into `_nds_replica_sync_status`. The
  `sync_status` view reads ONLY that table; counts sourced from projection
  tables (`conflicts_open`, `pending_local_changes`, the per-status local-change
  counts) stay computed live in the view.
- The per-data-source binding (`workspace_root`, `database_id`) materializes into
  new columns on `_nds_replica_data_sources`, which the `schema` view reads
  instead of joining `_nds_workspace_binding`. The binding is per-(root,
  data-source), so it cannot live in the root-keyed `_nds_replica_sync_status`.

Move-detection nuance: `sync_status.workspace_status` keeps the
`pragma_database_list` self-join against the data file's own `main` database (not
a cross-file ATTACH) and compares it to the MATERIALIZED `workspace_root`. This
preserves `moved` detection for a data file relocated AFTER projection; resolving
the status at projection time instead would tautologically report `bound`.

Also in SM3: the `sync_status` public column `rows` is renamed to `pages` (and
the `_nds_replica_sync_status.rows` column to `pages`), completing the
clean-break rename (spec R05 forbids row terminology in the public durable
schema).

## CDC crosses the file boundary

User edits land in the data file's `_nds_replica_*_changes` transient inbox
(driven by the public CDC triggers). The event log is in state.sqlite. The sync
flow drains the data-file CDC (`readPendingReplicaChanges` pointed at the data
file), appends the resulting intents to the state.sqlite event log
(idempotency-keyed by `replica:<change_id>`), executes them, settles them back
into the data-file CDC rows, and re-projects. The drain is idempotent: a
re-projection before settling neither consumes nor duplicates the un-settled CDC
inbox, and `readPendingReplicaChanges` returns the same change ids.

## `--sqlite` resolution rule (consequence of DD-A)

A path passed to `--sqlite` resolves in one of two ways:

- A genuinely self-contained file (carries its own control plane and binding):
  unified — the single file is both control plane and projection, exactly as
  before the split. This is the legacy / standalone fallback.
- A tracked workspace's data file (`<root>/data/v1/<name>.sqlite`, no embedded
  control plane): the control plane is the sibling `.notion/v1/state.sqlite`. The
  workspace root is derived from the fixed layout and routed through
  `discoverSelfContainedStore`, which fails closed on a mixed/unknown namespace.

A backup of just the data file is therefore standalone-QUERYABLE (its public
views, including move-detection, work read-only) but not OPERABLE (a workspace
command fails closed without the control plane). Operable backups copy the whole
workspace, not the data file alone.

## Considered Options

| Option                                                                                                                 | Result   | Reason                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Keep control plane in the data file; hide it behind a naming convention                                                | Rejected | The product surface would still ship the event log, outbox, and guards to users; "public file" would leak internal state. R02 wants control plane to be hidden implementation state.       |
| Split control plane into state.sqlite; ATTACH it from the data file for `sync_status`/`schema`                         | Rejected | Cross-file ATTACH breaks standalone-queryability of the data file (a backup/copy would error), and couples the public surface to the hidden file's path at query time.                     |
| Split control plane into state.sqlite; materialize control-plane facts into the projection at project time (DD-A/DD-B) | Selected | The data file stays standalone-queryable with no ATTACH; control-plane state is fully hidden; the `_nds_replica_*` cache remains rebuildable; CDC drains across the boundary idempotently. |

## Consequences

- The public data file ships only the product surface; control-plane internals
  are invisible to SQL users.
- `sync_status`/`schema` reflect control-plane state as of the last _successful_
  projection, not live — projection is wired on the success channel, so on a
  failed/blocked sync the `blocked_outbox`/`guard_blocks`/`incomplete_hydration`
  counts stay stale until the next successful projection (a follow-up could
  also project on the failure branch so blocked counts update when they matter).
- Deleting `data/v1/<source>.sqlite` is recoverable for settled state (re-project
  from state.sqlite); un-drained CDC-inbox edits are lost (drain via `sync`/`push`
  first). Deleting `.notion/v1/state.sqlite` is the durable-state loss.
- `--sqlite` against a workspace data file resolves the sibling control plane; a
  data-file-only copy is query-only, not operable.
