# Notion Datasource Sync Intuition

This companion document explains the human-facing idea behind
`@overeng/notion-datasource-sync`. It is not a normative requirements or spec
document; the authoritative product constraints live in [vision.md](./vision.md),
[requirements.md](./requirements.md), and [spec.md](./spec.md).

## The Short Version

Treat a Notion database like a Git working copy, but for structured data.

Notion remains the shared place where people collaborate. Your local machine gets
a versioned workspace with a public SQLite data file and `.nmd` page files. You
can inspect it with ordinary SQL, change supported page/property values locally,
edit page bodies as Markdown, and ask `notion db sync` to reconcile those
changes with Notion.

The important promise is not "everything syncs automatically." The promise is:
when sync cannot prove an edit is safe, it stops and tells you what needs a human
decision.

## The Mental Model

```
Notion database
  shared human workspace
        |
        | notion db track
        v
data/v1/tasks.sqlite
  local working copy
        |
        | SQL edits to pages
        v
pending changes
  explicit local intent
        |
        | notion db sync
        v
guarded Notion writes
  only after observation and verification
```

The SQLite file is not an export. It is the local API for one Notion database.
It contains the current row projection, the observed schema, pending local
changes, conflicts, and sync status. Private sync-control state lives under the
hidden `.notion/v1` namespace.

For a human, the main surfaces are:

| Surface             | How to think about it                                       |
| ------------------- | ----------------------------------------------------------- |
| `pages`             | The spreadsheet-like table you read and edit                |
| `schema`            | Which Notion database/data source this file represents      |
| `schema_properties` | How Notion properties map to SQL columns                    |
| `changes`           | Local edits that have not fully settled yet                 |
| `conflicts`         | Places where sync needs an explicit choice                  |
| `sync_status`       | Whether the replica is clean, pending, blocked, or degraded |

Hidden `.notion/v1` state is the machinery that makes the workspace
trustworthy. It is not an extension point.

## Why SQLite

SQLite gives humans and tools a stable local object to work with:

- it is easy to inspect with `sqlite3`, DB Browser, Datasette, scripts, or
  coding agents,
- it is durable and copyable as a user data file,
- it supports ordinary SQL for filtering, joining, auditing, and bulk local
  edits,
- it composes with hidden sync state needed to make reconciliation safe without
  exposing that state as user API.

This matters because a live Notion API call is a momentary observation. A local
SQLite replica is something you can diff, query, back up, and reason about.

## What A Local Edit Means

When you run:

```sql
update pages
set "Status" = 'Done'
where _page_id = '11111111-1111-4111-8111-111111111111';
```

you are not directly calling Notion. You are recording local intent inside the
replica. The next `notion db sync` decides whether that intent can be applied.

That distinction is the core safety boundary:

1. Local SQL records what you want.
2. Sync re-observes the relevant Notion state.
3. The planner compares local intent with the last known safe base.
4. Supported, non-conflicting edits become remote writes.
5. Remote writes settle only after Notion is observed again.

If the row changed remotely in a way that makes your local edit ambiguous, sync
records a conflict instead of guessing.

## What Sync Refuses To Guess

The system is deliberately conservative. It should block rather than silently
invent meaning for risky cases, including:

- deleting a page with `DELETE FROM pages`,
- changing computed or system properties,
- writing unsupported rich Notion surfaces,
- applying a local edit over stale remote state,
- treating an incomplete Notion query as proof that a page disappeared,
- rewriting private sync-control tables,
- destructive schema changes without a deliberate migration workflow.

The refusal is part of the product, not a missing convenience. A blocked edit is
recoverable; a silent wrong write is not.

## Bodies And Pages Are Adjacent

Notion data-source pages have page bodies. Datasource sync treats page properties and page
bodies as related but separate surfaces.

The SQLite file owns structured page/property data. `@overeng/notion-md` owns page-body
materialization and guarded body pushes. A normal sync experience can include
both, but their conflicts stay separate: a title/status edit should not
accidentally overwrite body text, and a body edit should not blur into page
property state.

## What "Trusted Local Replica" Means

Trusted does not mean the local file is always ahead of Notion or always free of
conflicts. It means the file contains enough evidence to explain what happened
and to avoid unsafe reconciliation.

A trusted replica has these properties:

- it knows which Notion database it represents,
- it records the schema and page state it observed,
- it records local edits before remote effects,
- it remembers pending work, conflicts, and verification evidence,
- it can rebuild public views from hidden sync events,
- it fails closed when hidden state is corrupt, unknown, or tampered with.

That is why `data/v1/<source>.sqlite` is more than a table dump. It is the
portable tabular user surface for one Notion data source.

## The Human Workflow

Start by establishing the local replica:

```sh
notion db track <database-url-or-data-source-id> ./notion-workspace
```

Inspect the data:

```sh
sqlite3 ./notion-workspace/data/v1/tasks.sqlite \
  'select _page_id, "Name", "Status" from pages limit 10;'
```

Make a supported local edit:

```sh
sqlite3 ./notion-workspace/data/v1/tasks.sqlite \
  "update pages set \"Status\" = 'Done' where _page_id = '...';"
```

Preview or apply reconciliation:

```sh
notion db sync ./notion-workspace --dry-run
notion db sync ./notion-workspace
```

Check whether anything still needs attention:

```sh
notion db status ./notion-workspace
notion db conflicts list ./notion-workspace
```

## Design North Star

The user should feel like they have a real local database, not a fragile cache.
They should be able to query it freely, make supported edits with ordinary SQL,
and trust sync to either apply those edits safely or explain why it will not.
