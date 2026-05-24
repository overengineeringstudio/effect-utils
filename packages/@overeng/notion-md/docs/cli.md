# CLI Reference

The binary is `notion-md`.

```sh
notion-md sync <page-id-or-url> <file.nmd>
notion-md sync <page-id-or-url> <dir>
notion-md sync <target> [--recursive] [--concurrency <n>] [--watch] [--poll-interval-ms <ms>] [--force] [--allow-delete-unknown-blocks] [--allow-review-markup]
notion-md status <target...> [--recursive] [--concurrency <n>]
```

## Environment

| Variable                                  | Required | Meaning                                           |
| ----------------------------------------- | -------- | ------------------------------------------------- |
| `NOTION_API_TOKEN`                        | yes      | Notion API token                                  |
| `NOTION_MD_TEST_PARENT_PAGE_ID_ALLOWLIST` | live e2e | Comma-separated parent page ids cleanup may touch |

## `sync <page> <target>`

```sh
notion-md sync <page-id-or-url> <file.nmd>
notion-md sync <page-id-or-url> <dir>
```

With a Notion page id or URL plus a local target, `sync` establishes local sync
state:

- file targets materialize one page into one `.nmd` file,
- directory targets create a managed workspace at `<dir>/.notion-md/workspace.json`
  and materialize the root page plus child pages.

After a workspace has been established, `notion-md sync <dir>` refreshes the
workspace and materializes newly discovered remote child pages.

## Targets

`status` accepts one or more file targets. Passing a single file emits a
single-page JSON result. Passing multiple files, or a directory with
`--recursive`, emits a batch result envelope.

`sync` accepts one local target. If that target is a managed workspace directory,
workspace metadata supplies the Notion root and `--recursive` is not required.
If the target is an unmanaged directory, pass `--recursive` to reconcile existing
local `.nmd` files only.

Unmanaged directory targets require `--recursive`; discovery walks nested
directories, finds existing `*.nmd` files, and skips `.notion-md`, `.git`, and
`node_modules`.

Batch options:

| Option          | Default | Meaning                                             |
| --------------- | ------- | --------------------------------------------------- |
| `--recursive`   | `false` | Discover `.nmd` files under directory targets       |
| `--concurrency` | `4`     | Maximum number of files reconciled at the same time |

Before mutating Notion, batch runs parse the candidate files and reject duplicate
`page_id` values in the same batch. Each `.nmd` still syncs through the same
guarded one-page engine as single-file commands.

## `status`

```sh
notion-md status <target...>
```

Reads local files, validates all referenced objects, pulls remote state, and
prints JSON status results.

For managed workspace directories, `status` also checks the configured remote
tree and reports missing local files without materializing them.

Use this before a sync when you want to know whether the local file, remote page,
or both have changed.

## `sync`

```sh
notion-md sync <target>
```

Runs one reconciliation pass for a local file, local folder, or
managed workspace.

Options:

| Option                          | Meaning                                                        |
| ------------------------------- | -------------------------------------------------------------- |
| `--force`                       | Allow overwriting remote body changes                          |
| `--allow-delete-unknown-blocks` | Allow a body replacement that can delete unsupported blocks    |
| `--allow-review-markup`         | Allow unresolved Roughdraft review markup to be sent to Notion |

## `sync --watch`

```sh
notion-md sync <target> --watch --poll-interval-ms 30000
```

Runs continuous sync. Local file events and remote poll events are coalesced.
One file target emits one-file watch events. Multiple files or recursive
directory targets use a batch watch envelope and reconcile affected files with
bounded concurrency.

Managed workspace watch is not implemented yet. Run one-shot
`notion-md sync <workspace>` periodically, or watch specific `.nmd` files /
unmanaged recursive directories when you need a long-running process.

Options:

| Option               | Default | Meaning                                 |
| -------------------- | ------- | --------------------------------------- |
| `--watch`            | `false` | Keep syncing after local or remote cues |
| `--poll-interval-ms` | `30000` | Remote polling interval in milliseconds |

## Output

One-shot commands print pretty JSON. Watch mode prints newline-delimited compact
JSON events.

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

The long-term machine contract is explicit output modes with versioned JSON and
NDJSON envelopes. The current implementation emits the operational envelope
shown above.
