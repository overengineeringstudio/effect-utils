# CLI Reference

The binary is `notion-md`.

```sh
notion-md track <page-id-or-url> [file-or-dir]
notion-md status <path...> [--recursive] [--concurrency <n>]
notion-md sync <path...> [--recursive] [--concurrency <n>] [--dry-run]
notion-md sync <path...> --watch [--poll-interval-ms <ms>]
```

`track` is the only command that accepts a Notion page id or URL. `status` and
`sync` accept local `.nmd` files or directories only. Files take direction from
required `source` frontmatter; Tracked Trees take it from workspace authority.

## Environment

| Variable                                  | Required | Meaning                                           |
| ----------------------------------------- | -------- | ------------------------------------------------- |
| `NOTION_API_TOKEN`                        | yes      | Notion API token                                  |
| `NOTION_MD_TEST_PARENT_PAGE_ID_ALLOWLIST` | live e2e | Comma-separated parent page ids cleanup may touch |

## Commands

| Command                                               | Meaning                                                                             |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `notion-md track <page-id-or-url> [file-or-dir]`      | Materialize one page into a file, or its child-page tree into an existing directory |
| `notion-md status <path...>`                          | Read-only live status for local `.nmd` files                                        |
| `notion-md status <dir>`                              | Read-only plan for a hierarchical Tracked Tree                                      |
| `notion-md status <dir> --recursive`                  | Read-only status for a flat batch of existing `.nmd` files                          |
| `notion-md sync <path...>`                            | Reconcile files by `source` or a Tracked Tree by workspace authority                |
| `notion-md sync <dir> --recursive --concurrency 4`    | Reconcile a flat batch of existing `.nmd` files                                     |
| `notion-md sync <path...> --watch --poll-interval-ms` | Keep files or flat recursive batches reconciling after local and remote cues        |

## `track`

```sh
notion-md track <page-id-or-url> notes.nmd
notion-md track <page-id-or-url> ./notes-directory
```

With a `.nmd` file or missing output path, `track` retains the single-page
behavior: it writes strict frontmatter with the page identity, parent, page
metadata, and explicit `source`.

An existing directory is detected from its filesystem type and invokes the
remote subtree materializer. The root becomes `index.nmd`, each child page gets
its own remote-authoritative nested `.nmd` file, and `.notion-md/workspace.json`
records remote authority plus the derived tree index. Later `sync <directory>`
passes refresh content and reconcile additions, page-id moves, and remote
deletions; deletion is limited to files recorded by the previous manifest whose
frontmatter still identifies the expected page. Unknown or rebound local files
are preserved or refused. Directory tracking supports `--as remote` only,
refuses a different root for an established workspace, and validates every
remote node under `--dry-run`; `--as local` and `--as shared` remain single-file
modes.

Remote titles become stable lowercase ASCII paths; German umlauts use the
conventional `ae` / `oe` / `ue` transliteration before general Unicode
normalization. Notion child placeholders and id-bearing child anchors become
relative Markdown links to the materialized child files. The stored remote
baseline strips those local navigation links and retains the canonical Notion
child anchors, so the guarded local tree composer remains a no-op at the
materialization baseline.

The default source is `remote`, because the first materialization starts from
Notion:

```sh
notion-md track <page-id-or-url> notes.nmd --as remote
notion-md track <page-id-or-url> notes.nmd --as local
notion-md track <page-id-or-url> notes.nmd --as shared
```

Use `source: local` with `page_id: null` when creating a new local-first page.
That case is handled by `sync`, not `track`, because there is no existing remote
page to track yet.

## `status`

```sh
notion-md status notes.nmd
notion-md status tracked-tree
notion-md status docs --recursive --concurrency 4
```

`status` reads local files, validates referenced local objects, observes current
Notion state, and reports the live decision without mutating local files,
Notion, sidecars, object storage, or conflict files.

Status vocabulary is shared with `sync` and watch output:

| Status         | Meaning                                                      |
| -------------- | ------------------------------------------------------------ |
| `in-sync`      | Local and remote modeled body are semantically equivalent    |
| `local-ahead`  | Local body differs and the file's source makes local winning |
| `remote-ahead` | Remote body differs and the file's source makes remote win   |
| `diverged`     | Shared sync saw concurrent body edits requiring resolution   |
| `unbound`      | Local-first file has no remote page id yet                   |

## `sync`

```sh
notion-md sync notes.nmd
notion-md sync docs --recursive --concurrency 4
```

`sync` runs one reconciliation pass for local paths and does not accept Notion
page ids. A file's frontmatter decides its mechanism; a non-recursive directory
uses its workspace manifest's `local` or `remote` authority:

| `source` | Normal sync behavior                                                     |
| -------- | ------------------------------------------------------------------------ |
| `local`  | Mirror the local modeled body to Notion; create the page if unbound      |
| `remote` | Mirror the remote modeled body to the local file                         |
| `shared` | Use base-anchored shared reconciliation and refuse unresolved divergence |

Options:

| Option                          | Meaning                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `--dry-run`                     | Plan and validate without mutating Notion or local sync state                                             |
| `--force`                       | Shared-sync local-wins override for unresolved body divergence                                            |
| `--allow-delete-unknown-blocks` | Explicit destructive mode for body writes that may delete unresolved unsupported Notion blocks            |
| `--allow-review-markup`         | Explicit mode for writing unresolved Roughdraft review markup as literal Notion body content              |
| `--gc-objects`                  | Remove unreachable `.notion-md/objects` files after validation; with `--dry-run`, report the GC plan only |
| `--recursive`                   | Discover existing `.nmd` files under directory targets                                                    |
| `--concurrency`                 | Maximum number of files reconciled at the same time                                                       |

Destructive body writes that would drop unsupported Notion blocks, and writes
that would send unresolved Roughdraft review markup to Notion, fail closed
unless the matching explicit mode is present. `--allow-delete-unknown-blocks`
sets Notion's destructive body-write permission only for that sync pass.
`--allow-review-markup` sends the markup literally; it does not bridge review
state to Notion comments.

`--recursive` is flat batch discovery. It does not imply hierarchy,
materialize child pages, move files, or trash pages missing locally.

## `sync --watch`

```sh
notion-md sync notes.nmd --watch --poll-interval-ms 30000
notion-md sync docs --recursive --watch --poll-interval-ms 30000
```

Watch mode runs the same file reconciliation pass after local file changes and
on a remote polling interval. One file target emits one-file watch events.
Multiple files or recursive directory targets use a batch watch envelope and
reconcile affected files with bounded concurrency.

A hierarchical directory tree without `--recursive` is rejected: tree sync is
currently one-shot, and must not fall through to one-file watch on the directory
path. `--recursive` explicitly selects flat file watch rather than tree
reconciliation.

Options:

| Option               | Default | Meaning                                    |
| -------------------- | ------- | ------------------------------------------ |
| `--watch`            | `false` | Keep syncing after local or remote cues    |
| `--poll-interval-ms` | `30000` | Remote polling interval in milliseconds    |
| `--dry-run`          | `false` | Keep watch live while each pass plans only |

The watched file set is resolved at startup. Restart the flat batch watcher after
adding a new `.nmd` file.

## Output

One-shot commands print JSON or compact porcelain output depending on command
options. Watch mode prints newline-delimited compact JSON events.

Error payloads can include local paths and Notion page ids. Treat CLI stdout as
operational output; redact it before pasting into public issues or logs.

Batch result example:

```json
{
  "_tag": "batch",
  "operation": "sync",
  "total": 2,
  "succeeded": 1,
  "failed": 1,
  "items": [
    { "_tag": "success", "operation": "sync", "path": "a.nmd", "result": { "_tag": "pushed" } },
    {
      "_tag": "error",
      "operation": "sync",
      "path": "b.nmd",
      "error": { "_tag": "NmdConflictError" }
    }
  ]
}
```

Watch event examples:

```json
{"event":"sync","reason":"file","result":{"_tag":"pushed"}}
{"event":"sync_error","reason":"poll","error":{"_tag":"NmdConflictError","message":"Remote page changed since the last clean pull"}}
```
