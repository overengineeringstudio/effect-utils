# CLI Spec

Sub-system slice of [spec.md](../../spec.md). Serves [requirements](./requirements.md).

Requirement trace: CLI-R01, CLI-R02, CLI-R03, CLI-R04, CLI-R05.

This sub-system defines the command surface, establishment flow, dry-run rules,
and structured output for the datasource-sync CLI and the replica helpers.

## Commands

| Command                   | Primary flags                                                                                                                         | Purpose                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `sync --from-notion`      | `<data-source-id-or-database-url>`, `<workspace-root>`, `--dry-run`, `--limit`, `--no-materialize-bodies`                             | Establish a local workspace from an existing Notion data source; remote-to-local only                               |
| `sync <workspace-root>`   | `--dry-run`, `--max-attempts`                                                                                                         | Reconcile an established workspace through local-capture-first planning                                             |
| `status <workspace-root>` | `--json`, `--porcelain`                                                                                                               | Show local edits, remote drift, conflicts, tombstones, outbox state for an established workspace                    |
| `init`                    | `--data-source-id`, `--root`, `--sqlite`                                                                                              | Advanced: bind a local root to a Notion data source without observing it                                            |
| `pull`                    | `--since`, `--full-scan`, `--dry-run`                                                                                                 | Advanced: observe remote schema/rows/body pointers and materialize local projections                                |
| `status`                  | `--json`, `--porcelain`                                                                                                               | Show local edits, remote drift, conflicts, tombstones, outbox state                                                 |
| `push`                    | `--dry-run`, `--conflict-policy`                                                                                                      | Plan and apply local intents to Notion with guards                                                                  |
| `sync`                    | `--dry-run`, `--max-attempts`, `--watch`, `--state`, `--max-cycles`, `--mode`, `--webhook`, `--webhook-required`, `--non-interactive` | Pull, plan, push, settle, refresh, or run the local daemon for established replicas                                 |
| `conflicts list`          | `--json`                                                                                                                              | List open conflicts                                                                                                 |
| `conflicts resolve`       | `--strategy`, `--manual-value`                                                                                                        | Append conflict resolution events and follow-up commands                                                            |
| `migrate store`           | `--to`, `--dry-run`                                                                                                                   | Execute forward-only SQLite migrations                                                                              |
| `migrate schema`          | `--plan`, `--dry-run`, `--apply`                                                                                                      | Plan or apply explicit Notion schema migrations                                                                     |
| `doctor`                  | `--repair-plan`, `--json`, `--capabilities`                                                                                           | Verify store health, API contract, capabilities, query checkpoints, projections, path claims, leases, and artifacts |
| `repair`                  | `--projection`, `--paths`, `--body-artifacts`                                                                                         | Rebuild projections or regenerate missing local artifacts                                                           |
| `forget`                  | `--page-id`, `--path`, `--dry-run`                                                                                                    | Remove local tracking without remote mutation                                                                       |
| `restore`                 | `--page-id`, `--dry-run`                                                                                                              | Restore trashed/moved state when supported and verified                                                             |

The command set spans init, pull, status, push, sync, `sync --watch`,
conflicts, migrate, doctor, repair, forget, and restore (CLI-R01). There is no
standalone user-facing `watch` command; the daemon is reached through
`sync --watch` (see [../watch-daemon/spec.md](../watch-daemon/spec.md)).

Workspace establishment writes `<workspace>/<database-id>.sqlite` under the
workspace root. The database file is named with the Notion database ID, not the
display name, and contains the public API plus private `_nds_*` event/outbox
state. No `.notion-datasource-sync/store.sqlite` or config sidecar is required
state, and there is no compatibility mode for split-store layouts or partial
query-contract replicas. If the filename, public `schema` metadata, and private
`_nds_*` binding disagree, established commands fail closed.

Normal direct editing uses the workspace artifacts: edit database properties and
lifecycle through the public SQLite `rows` table, and edit page bodies through
the materialized `.nmd` files. Users do not need to write `_nds_*`, outbox,
planner, or daemon state directly; `changes` is an advanced public intent ledger
and observability surface for cases where direct `rows` editing is not enough.

## Establishment Flow

First establishment is a distinct mode:

1. parse and validate the Notion data-source id or database URL,
2. discover existing `<database-id>.sqlite` files if present,
3. fail closed on a different configured database/data source,
4. resolve database URLs to their single child data source, failing closed on zero or multiple child data sources,
5. validate the remote data source through the gateway,
6. record `SyncBindingRecorded` if not already present,
7. pull remote schema, metadata, rows, page properties, and body pointers,
8. project observations into `<database-id>.sqlite`,
9. materialize bodies unless disabled,
10. report status without scanning local write intents, planning pushes, enqueuing outbox commands, or mutating Notion.

The product CLI's live Notion runtime materializes bodies through the NotionMD-backed
workspace adapter, so enabled body materialization writes real `.nmd` files plus
NotionMD/datasource-sync sidecars. Placeholder body files are only the generic
filesystem workspace behavior for explicitly injected or non-NotionMD adapters.

## Dry-Run Rules

Mutating commands support `--dry-run`, showing planned events, conflicts, outbox
commands, and guard failures (CLI-R02). Establishment dry-run is true no-write:
no replica file, private events, sidecars, body files, outbox commands, or
Notion mutations. `sync --from-notion --dry-run --limit <rows>` is a bounded
preview for large databases: it caps remote rows observed, marks query
completeness as capped, and cannot be applied as a partial adoption. Established
sync dry-run suppresses replica mutation, intent settlement, private
event/outbox/remote writes, and body materialization while using the existing
database file for read-only local capture and planning.

## Established Sync Ordering

Established `sync <workspace-root>` follows
[sync-orchestration](../sync-orchestration/spec.md): capture local desired state
from public SQLite and `.nmd` files, observe remote state, plan, execute, then
guard materialization. It must not run remote body materialization before local
`.nmd` observations have been captured and either planned or preserved.

`push` is the local-only command mode over the same captured desired-state and
outbox executor semantics; it may scope remote reads to the surfaces needed for
preflight, but it must not skip SQLite public CDC or `.nmd` body observations.
`pull` and remote-only repair modes may update local artifacts only through
guarded materialization and must preserve pending local desired state.

## Progress And Output

Sync-family commands (`init`, `pull`, `push`, `sync`, and `sync --from-notion`)
render live human progress through the shared `@overeng/tui-react` terminal app
(CLI-R05). The progress renderer is a side channel: the final command result
remains structured JSON on stdout, while progress frames, phase names, row/page
counters, hydration counters, and executor-step updates render on stderr. This
preserves shell pipelines and agent consumers while making long Notion scans
visibly active in both TTY and CI/plain output modes.

The progress side channel also includes sanitized Notion HTTP quota state:
request count, route-level operation, status, remaining quota when Notion
returns it, reset timing, and retry delay. Route-level operation names replace
raw Notion IDs so operators can see where quota is spent without leaking page,
database, or workspace identifiers.

## Large-Cardinality Note

Large-cardinality acceptance is bounded by explicit completeness and memory
claims. Query observation progresses by Notion pages and records
capped/incomplete status when a limit or API cap prevents completeness. Bounded
large-database previews and targeted scratch-row checks are verification tools,
not product modes; they must not create partial `<database-id>.sqlite` replicas.

## Structured Output

Structured output uses one envelope, supporting machine-readable mode for CI and
agent workflows (CLI-R03):

```ts
type CliResult = {
  readonly command: string
  readonly rootId: SyncRootId
  readonly apiVersion: NotionApiVersion
  readonly status: 'clean' | 'changed' | 'blocked' | 'conflict' | 'error'
  readonly plannedEvents: readonly SafeEventSummary[]
  readonly plannedCommands: readonly SafeCommandSummary[]
  readonly conflicts: readonly SafeConflictSummary[]
  readonly guards: readonly GuardFailureSummary[]
  readonly telemetryTraceId: string | null
}
```

Human output is a rendering of this envelope; it is not a separate source of
truth. It provides concise human-readable explanations for conflicts, blocked
guards, retries, tombstones, and migrations (CLI-R04).

## Replica CLI Helpers

Replica-specific CLI helpers are wrappers around the same public SQLite API
defined in [../replica-api/spec.md](../replica-api/spec.md):

| Command                 | Purpose                                                                          |
| ----------------------- | -------------------------------------------------------------------------------- |
| `replica schema`        | Print the stable `<database-id>.sqlite` table/view/intent contract               |
| `replica changes`       | List pending local intents and their guard status                                |
| `replica rebuild`       | Rebuild public tables/views from private `_nds_*` sync-control state             |
| `replica clear-applied` | Remove or compact settled local intent rows after they are represented by events |

These helpers may be staged after the generic tables exist, but they must not
define a separate write path. They read or write the same public tables that
users can inspect directly. Local deletion and tombstone semantics referenced by
these helpers are owned by [../replica-api/spec.md](../replica-api/spec.md).

## Doctor Capabilities

`doctor --capabilities` performs read, query, update, schema, trash, restore,
parent-access, markdown, and page-property pagination preflights against
disposable or explicitly selected test objects. Until capability preflight
passes, 403/404/update failures are reported as capability failures rather than
delete, move, or conflict facts.
