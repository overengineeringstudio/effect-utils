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

## First Sync

```sh
notion-md sync 00000000000040008000000000000001 notes.nmd
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
to re-sync from the Notion page id to rebuild it rather than silently sync
against a non-baseline.

To start from a Notion page tree instead of a single page, use a directory
target:

```sh
notion-md sync docs --from-remote --root 00000000000040008000000000000001
```

This creates `docs/.notion-md/workspace.json` as an internal tree index, writes
the root page to `docs/index.nmd`, and materializes child pages using
deterministic slug paths. Later, `notion-md plan docs` previews the tree diff
and `notion-md sync docs` applies the local directory as desired tree state.

To create a new page from local tree state, add a `.nmd` file with
`page_id: null` and a valid `parent` reference, then run `notion-md sync docs`.
The applied create result includes the new `pageId` and `url`, and the file is
rewritten with that binding.

## Creating A New Local File

Create the page in Notion first, then materialize it locally:

```sh
notion-md sync <page-id-or-url> notes.nmd
```

The generated `.nmd` includes the page id, frontmatter, local sync state, and
base snapshot required for guarded two-way sync.

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
`notion-md sync docs` when you want to apply the local tree, or
`notion-md sync docs --from-remote --root <page-id-or-url>` when you want to
refresh from Notion.
