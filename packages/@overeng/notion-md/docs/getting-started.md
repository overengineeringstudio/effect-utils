# Getting Started

`notion-md` syncs one Notion page with one local `.nmd` file. The Markdown body is
stock Notion enhanced Markdown; sync metadata lives in strict frontmatter and, for
large or immutable evidence, `.notion-md/objects`.

## Credentials

Set the Notion token before running commands:

```sh
export NOTION_TOKEN="secret_..."
```

The integration must have access to the page you sync. If a command can
authenticate but cannot read the page, share the page with the integration in
Notion.

## First Pull

```sh
notion-md pull 00000000000040008000000000000001 --out notes.nmd
```

This writes:

- `notes.nmd`, containing strict frontmatter and the Notion enhanced Markdown
  body.
- `.notion-md/objects/sha256/...`, containing the last clean body snapshot and
  any overflow metadata.

Commit both the `.nmd` file and its reachable `.notion-md` objects when using
Git. The object store is part of the local sync state, not a disposable cache.

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
