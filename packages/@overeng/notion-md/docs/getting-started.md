# Getting Started

`notion-md` syncs Notion pages with local `.nmd` files. The Markdown body is
stock Notion enhanced Markdown; sync metadata lives in strict frontmatter and,
for large or immutable evidence, `.notion-md/objects`.

## Credentials

Set the Notion token before running commands:

```sh
export NOTION_API_TOKEN="secret_..."
```

The integration must have access to the page you sync. If a command can
authenticate but cannot read the page, share the page with the integration in
Notion.

## Track An Existing Page

```sh
notion-md track 00000000000040008000000000000001 notes.nmd
```

This writes:

- `notes.nmd`, containing strict frontmatter (user-facing only) and the Notion
  enhanced Markdown body.
- `.notion-md/objects/sha256/...` when immutable overflow evidence is needed.
- `.notion-md/sync/<page_id>.json` only for `source: shared` pages that need a
  base snapshot for shared reconciliation.

Commit both the `.nmd` file and its reachable `.notion-md` objects when using
Git. The object store is part of the local sync state, not a disposable cache.

To track a page as local-authoritative or shared-authoring state, choose the
source explicitly:

```sh
notion-md track <page-id-or-url> notes.nmd --as local
notion-md track <page-id-or-url> notes.nmd --as shared
```

## Create A New Local Page

For local-first creation, create a `.nmd` file with `source: local`,
`page_id: null`, and a valid `parent` reference, then run:

```sh
notion-md sync notes.nmd
```

The applied create result includes the new `pageId` and `url`, and the file is
rewritten with that binding. `track` is only for existing Notion pages.

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

## Sync Local Edits

```sh
notion-md sync notes.nmd
```

A normal sync is guarded. It refuses to overwrite remote body edits unless the
remote body still matches the last clean base or a conservative automatic merge
can prove the edits do not overlap.

Use `--force` only after inspecting the remote change:

```sh
notion-md sync notes.nmd --force
```

## One-Shot Sync

```sh
notion-md sync notes.nmd
```

`sync` runs one reconciliation pass. It accepts a single `.nmd`, a directory
tree, or a flat batch directory with `--recursive`:

```sh
notion-md sync docs --recursive --concurrency 4
```

- local-only changes are pushed through the guarded push path,
- remote-only changes are pulled,
- clean files are left unchanged,
- conflicting local and remote body edits fail with a conflict artifact.

Use `--dry-run` to run the same planning and validation without mutating Notion,
local files, sidecars, object storage, or conflict files:

```sh
notion-md sync notes.nmd --dry-run
```

## Watch Mode

```sh
notion-md sync notes.nmd --watch --poll-interval-ms 30000
```

Watch mode runs the same reconciliation pass after local file changes and on a
remote polling interval. It emits one compact JSON line per sync event or
recoverable sync error.

Flat recursive directory targets can share one watch process:

```sh
notion-md sync docs --recursive --watch --poll-interval-ms 30000
```

The watched file set is resolved at startup. Restart the watcher after adding a
new `.nmd` file. Concurrent writers can still create real conflicts, and those
should be resolved through the same guarded conflict flow.

Directory tree watch is not implemented yet. Use one-shot
`notion-md sync docs` when you want to apply the local tree.
