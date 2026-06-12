# CLI Reference

The binary is `notion-md`.

```sh
notion-md track <page-id-or-url> [file-or-dir]
notion-md status <path...> [--recursive] [--concurrency <n>]
notion-md sync <path...> [--recursive] [--concurrency <n>]
notion-md sync <path...> --watch [--poll-interval-ms <ms>]
```

`track` is the only command that accepts a Notion page id or URL. `status` and
`sync` accept local `.nmd` files or directories only. Sync direction lives in
each file's required `source` frontmatter field.

## Environment

| Variable                                  | Required | Meaning                                           |
| ----------------------------------------- | -------- | ------------------------------------------------- |
| `NOTION_API_TOKEN`                        | yes      | Notion API token                                  |
| `NOTION_MD_TEST_PARENT_PAGE_ID_ALLOWLIST` | live e2e | Comma-separated parent page ids cleanup may touch |

## Commands

| Command                                               | Meaning                                                                 |
| ----------------------------------------------------- | ----------------------------------------------------------------------- |
| `notion-md track <page-id-or-url> [file-or-dir]`      | Materialize an existing Notion page as tracked local `.nmd` state       |
| `notion-md status <path...>`                          | Read-only live status for local `.nmd` files                            |
| `notion-md status <dir> --recursive`                  | Read-only status for existing `.nmd` files discovered under a directory |
| `notion-md sync <path...>`                            | Reconcile local paths toward in-sync according to each file's `source`  |
| `notion-md sync <dir> --recursive --concurrency 4`    | Reconcile a flat batch of existing `.nmd` files                         |
| `notion-md sync <path...> --watch --poll-interval-ms` | Keep reconciling after file events and remote polling                   |

## `track`

```sh
notion-md track <page-id-or-url> notes.nmd
```

`track` establishes a local tracked file for an existing Notion page. It writes
strict frontmatter with the page identity, parent, page metadata, and explicit
`source`.

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

`sync` runs one reconciliation pass for local paths. The command does not accept
Notion page ids. Each file's frontmatter decides the mechanism:

| `source` | Normal sync behavior                                                     |
| -------- | ------------------------------------------------------------------------ |
| `local`  | Mirror the local modeled body to Notion; create the page if unbound      |
| `remote` | Mirror the remote modeled body to the local file                         |
| `shared` | Use base-anchored shared reconciliation and refuse unresolved divergence |

Options:

| Option          | Meaning                                                        |
| --------------- | -------------------------------------------------------------- |
| `--dry-run`     | Plan and validate without mutating Notion or local sync state  |
| `--force`       | Shared-sync local-wins override for unresolved body divergence |
| `--recursive`   | Discover existing `.nmd` files under directory targets         |
| `--concurrency` | Maximum number of files reconciled at the same time            |

Destructive body writes that would drop unsupported Notion blocks, and writes
that would send unresolved Roughdraft review markup to Notion, fail closed in
the v-next CLI. There is no override flag until the destructive mode for that
surface is implemented explicitly.

`--recursive` is flat batch discovery. It does not imply hierarchy,
materialize child pages, move files, or trash pages missing locally.

## `sync --watch`

```sh
notion-md sync notes.nmd --watch --poll-interval-ms 30000
notion-md sync docs --recursive --watch --poll-interval-ms 30000
```

Watch mode runs the same reconciliation pass after local file changes and on a
remote polling interval. One file target emits one-file watch events. Multiple
files or recursive directory targets use a batch watch envelope and reconcile
affected files with bounded concurrency.

Options:

| Option               | Default | Meaning                                    |
| -------------------- | ------- | ------------------------------------------ |
| `--watch`            | `false` | Keep syncing after local or remote cues    |
| `--poll-interval-ms` | `30000` | Remote polling interval in milliseconds    |
| `--dry-run`          | `false` | Keep watch live while each pass plans only |

The watched file set is resolved at startup. Restart the watcher after adding a
new `.nmd` file.

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
