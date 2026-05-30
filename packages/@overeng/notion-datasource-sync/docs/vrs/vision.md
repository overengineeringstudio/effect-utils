# Notion Datasource Sync Vision

## The Problem

Notion's UI is excellent for humans working _in Notion_. But once work moves
local, it is better served by trusted local files — markdown and SQLite — than by
the live Notion API or CLI.

- **Coding agents** are the primary motivating audience. An agent reasons, diffs,
  and edits far better over a durable local artifact than over live API calls.
- **Scripts and tooling** want a stable local data surface they can query and
  write without re-deriving Notion's API on every run.
- **Humans working locally** (editor, CLI) are a secondary audience, served the
  same way.

The Notion API and CLI are useful steps toward local work, but a trusted local
artifact is preferable: it is present, queryable, and diffable without a round
trip.

## The Vision

A Notion data source as a **trusted local SQLite file you query and write**. This
extends the `.nmd` analogy from page bodies to rows, schema, and lifecycle: where
`@overeng/notion-md` makes a page body a local file you read and edit, datasource
sync makes a data source a local `<database-id>.sqlite` you read and edit.

- `<database-id>.sqlite` is the local data API. You inspect schema and rows with
  plain SQL and write supported edits there, and the CLI reconciles them against
  Notion.
- "Trusted" is the load-bearing word: the local file is something you can act on
  with confidence, and sync never silently loses or corrupts data to keep the
  file and Notion in agreement.
- Notion stays authoritative for current remote facts after observation. The
  local file is authoritative for your local intent and the history needed to
  reconcile it.
- It composes with `@overeng/notion-md` for page bodies, keeping page bodies and
  data-source rows as distinct but adjacent local surfaces.

## What This Is Not

- It is not a built-in feature of `@overeng/notion-md`. It is a standalone
  primitive that composes with it.
- It is not a full offline Notion clone.
- It is not a last-writer-wins backup tool.
- It is not an automatic destructive schema migration tool.
- It is not a replacement for Notion permissions, ownership, or workspace policy.
- It is not dependent on Notion Workers, webhooks, or any hosted callback path for
  correctness.

## Success Criteria

1. A coding agent or human can query the local `<database-id>.sqlite` with plain
   SQL and safely edit supported data — `UPDATE`/`INSERT`/`DELETE` rows,
   archive/restore — with the CLI reconciling those edits against Notion.
2. Page bodies and data-source rows stay distinct: `@overeng/notion-md` supplies
   page-body files without depending on datasource-sync internals.
3. A sync never silently loses data: stale, ambiguous, lossy, or unsupported
   writes are refused with a clear reason rather than overwriting state.
4. Disjoint local and remote edits merge automatically; conflicting same-surface
   edits surface explicitly with resolution commands.
5. Safe additive schema edits are possible as explicit intents; destructive or
   rich schema migrations require a deliberate migration workflow with an impact
   report.
6. Continuous sync can run for long periods, recover after interruption, and
   repair missed changes without relying on webhooks or Workers for correctness.
