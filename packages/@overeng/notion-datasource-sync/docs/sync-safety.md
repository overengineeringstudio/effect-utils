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

## Establishment

The normal onboarding command is:

```sh
notion-datasource-sync sync --from-notion <data-source-id-or-url> <workspace-root>
```

Establishment has a distinct execution mode. It validates the existing Notion
data source, records the local binding, observes remote state, and materializes
remote bodies when enabled. It does not scan local artifacts, plan local writes,
enqueue outbox commands, execute remote writes, or rebind an already configured
workspace to a different data source.

`sync --from-notion ... --dry-run` is no-write: no config file, store events,
sidecars, body files, outbox commands, or Notion mutations. For large existing
databases, add `--limit <rows>` to bound the remote preview; capped previews are
reported as incomplete and cannot be applied as partial adoption. Established
`sync <workspace-root> --dry-run` suppresses event/outbox/remote writes and body
materialization while still using the existing store for read-only planning.

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

The current safe subset supports explicit additive or non-destructive operations
with an expected base schema hash:

- add property,
- rename property,
- add select options,
- add multi-select options.

Unsupported schema operations include property deletion, type conversion,
destructive option replacement/removal, automatic status updates, and broad
schema convergence without an explicit app-owned policy.
