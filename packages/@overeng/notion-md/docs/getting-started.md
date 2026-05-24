# Getting Started

`notion-md` syncs one Notion page with one local `.nmd` file. The Markdown body is
stock Notion enhanced Markdown; sync metadata lives in strict frontmatter and, for
large or immutable evidence, `.notion-md/objects`.

## Credentials

Set the Notion token before running commands:

```sh
export NOTION_API_TOKEN="secret_..."
```

The integration must have access to the page you sync. If a command can
authenticate but cannot read the page, share the page with the integration in
Notion.

## First Pull

```sh
notion-md pull 00000000000040008000000000000001 --out notes.nmd
```

This writes:

- `notes.nmd`, containing strict frontmatter (user-facing only) and the Notion
  enhanced Markdown body.
- `.notion-md/sync/<page_id>.json`, the sidecar sync state keyed by the
  immutable page id (body hash, base ref, last-pulled timestamps, storage
  inventory, read-only property echoes).
- `.notion-md/objects/sha256/...`, containing the last clean body snapshot and
  any overflow metadata.

Commit both the `.nmd` file and its reachable `.notion-md` objects when using
Git. The object store is part of the local sync state, not a disposable cache.
The sidecar can be gitignored — if it goes missing, `notion-md` will tell you
to re-`pull` to rebuild it rather than silently sync against a non-baseline.

## Creating A New Page From Markdown

Author a `.nmd` file with `page_id: null` and a `parent` set; the first
`push` materializes the Notion page and fills in `page_id` plus the
sidecar:

```
---
{
  "notion_md": {
    "version": 2,
    "api_version": "2026-03-11",
    "object": "page",
    "page_id": null,
    "parent": { "_tag": "page", "id": "<parent-page-id>" },
    "page": { "title": "Patterns", "icon": null, "cover": null, "in_trash": false, "is_locked": false },
    "properties": {}
  }
}
---

Body goes here.
```

Notion's create endpoint deduplicates the first H1 of the initial body
against the page title. If `page.title` is `"Patterns"` and the body starts
with `# Patterns`, Notion drops the H1 — pick one home.

## Edit And Inspect

Edit only the Markdown body unless you intentionally want to change modeled
frontmatter fields such as writable properties.

```sh
notion-md status notes.nmd
```

`status` compares:

- local body hash,
- remote body hash,
- remote page metadata,
- modeled local property edits,
- referenced object-store integrity.

## Push Local Edits

```sh
notion-md push notes.nmd
```

A normal push is guarded. It refuses to overwrite remote body edits unless the
remote body still matches the last clean base or a conservative automatic merge
can prove the edits do not overlap.

Use `--force` only after inspecting the remote change:

```sh
notion-md push notes.nmd --force
```

## One-Shot Sync

```sh
notion-md sync notes.nmd
```

`sync` runs one reconciliation pass. It accepts a single `.nmd`, multiple
`.nmd` files, or a directory with `--recursive`:

```sh
notion-md sync docs --recursive --concurrency 4
```

- local-only changes are pushed through the guarded push path,
- remote-only changes are pulled,
- clean files are left unchanged,
- conflicting local and remote body edits fail with a conflict artifact.

## Watch Mode

```sh
notion-md sync notes.nmd --watch --poll-interval-ms 30000
```

Watch mode runs the same reconciliation pass after local file changes and on a
remote polling interval. It emits one compact JSON line per sync event or
recoverable sync error.

Multiple file targets and recursive directory targets can share one watch
process:

```sh
notion-md sync docs --recursive --watch --poll-interval-ms 30000
```

The watched file set is resolved at startup. Restart the watcher after adding a
new `.nmd` file. Concurrent writers can still create real conflicts, and those
should be resolved through the same guarded conflict flow.
