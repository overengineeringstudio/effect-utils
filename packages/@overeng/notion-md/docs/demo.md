# Demo Fixture

The package includes a durable local Notion Markdown fixture:

```text
packages/@overeng/notion-md/demo/showcase.nmd
packages/@overeng/notion-md/demo/.notion-md/objects/sha256/...
packages/@overeng/notion-md/demo/workspace/
```

It syncs with this Notion page:

https://www.notion.so/overeng-notion-md-demo-automated-369f141b18dc80e4850cff344ad5b48e

The fixture demonstrates the intended local shape:

- a human-editable `.nmd` file,
- strict frontmatter generated from Notion,
- a stock Notion enhanced Markdown body,
- content-addressed base evidence under `.notion-md/objects`,
- clean `status` against the remote page after a successful sync.

The `demo/workspace/` tree is a flat recursive batch template. It contains
`.nmd.example` files in nested folders so users can see the intended shape
without making broad recursive commands contact placeholder page ids.

## Git Policy

Commit the demo `.nmd` file and every reachable object referenced from its
frontmatter. For the automated demo this means the current
`demo/showcase.nmd` file plus its current `base_snapshot` object under
`demo/.notion-md/objects/sha256/...`.

Do not keep stale unreachable demo objects. They are immutable evidence for old
base snapshots, but once the committed `.nmd` frontmatter no longer references
them they only add noise and can make reviewers think multiple local states are
authoritative.

## Verify

```sh
export NOTION_API_TOKEN="secret_..."
notion-md status packages/@overeng/notion-md/demo/showcase.nmd
```

A clean fixture reports:

```json
{
  "localChanged": false,
  "remoteChanged": false,
  "remoteBodyChanged": false
}
```

## Flat Recursive Batch

Populate the directory by syncing real pages into `.nmd` files next to the
examples:

```sh
export NOTION_API_TOKEN="secret_..."

notion-md sync <overview-page-id> \
  packages/@overeng/notion-md/demo/workspace/project/overview.nmd

notion-md sync <weekly-notes-page-id> \
  packages/@overeng/notion-md/demo/workspace/project/weekly-notes/2026-05-23.nmd
```

Then exercise the batch envelope and recursive discovery:

```sh
notion-md status packages/@overeng/notion-md/demo/workspace --recursive
notion-md sync packages/@overeng/notion-md/demo/workspace --recursive --concurrency 4
notion-md sync packages/@overeng/notion-md/demo/workspace --recursive --watch --poll-interval-ms 30000
```

Keep the durable `showcase.nmd` fixture separate from this batch template.
It is the only checked-in live page fixture today.

## Edit

Edit only the Markdown body unless you intentionally want to exercise
frontmatter property writes.

```sh
notion-md sync packages/@overeng/notion-md/demo/showcase.nmd
notion-md sync 369f141b18dc80e4850cff344ad5b48e packages/@overeng/notion-md/demo/showcase.nmd
```

Sync from the page id after local writes when you want to commit Notion's
normalized enhanced Markdown and the new base snapshot.
