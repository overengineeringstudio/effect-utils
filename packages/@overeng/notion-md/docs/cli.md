# CLI Reference

The binary is `notion-md`.

```sh
notion-md pull <page-id> --out <file.nmd>
notion-md status <target...> [--recursive] [--concurrency <n>]
notion-md push <target...> [--recursive] [--concurrency <n>] [--force] [--allow-delete-unknown-blocks] [--allow-review-markup]
notion-md sync <target...> [--recursive] [--concurrency <n>] [--watch] [--poll-interval-ms <ms>] [--force] [--allow-delete-unknown-blocks] [--allow-review-markup]
```

## Environment

| Variable                                  | Required | Meaning                                           |
| ----------------------------------------- | -------- | ------------------------------------------------- |
| `NOTION_API_TOKEN`                        | yes      | Notion API token                                  |
| `NOTION_MD_TEST_PARENT_PAGE_ID_ALLOWLIST` | live e2e | Comma-separated parent page ids cleanup may touch |

## `pull`

```sh
notion-md pull <page-id> --out <file.nmd>
```

Pulls page metadata, page properties, Notion enhanced Markdown, unknown-block
metadata, and local storage evidence into a `.nmd` file.

Options:

| Option        | Meaning                 |
| ------------- | ----------------------- |
| `--out`, `-o` | Output `.nmd` file path |

## Targets

`status`, `push`, and `sync` accept one or more file targets. Passing a single
file preserves the original single-result JSON output. Passing multiple files,
or a directory with `--recursive`, emits a batch result envelope.

Directory targets require `--recursive`; discovery walks nested directories,
finds existing `*.nmd` files, and skips `.notion-md`, `.git`, and
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

Use this before a push when you want to know whether the local file, remote page,
or both have changed.

## `push`

```sh
notion-md push <target...>
```

Pushes local body and modeled property edits after safety checks.

Options:

| Option                          | Meaning                                                        |
| ------------------------------- | -------------------------------------------------------------- |
| `--force`                       | Allow overwriting remote body changes                          |
| `--allow-delete-unknown-blocks` | Allow a body replacement that can delete unsupported blocks    |
| `--allow-review-markup`         | Allow unresolved Roughdraft review markup to be sent to Notion |

## `sync`

```sh
notion-md sync <target...>
```

Runs one pull-or-push reconciliation pass per target. It uses the same safety
flags as `push`.

## `sync --watch`

```sh
notion-md sync <target...> --watch --poll-interval-ms 30000
```

Runs continuous sync. Local file events and remote poll events are coalesced.
One file target uses the original one-file watch envelope. Multiple files or
recursive directory targets use a batch watch envelope and reconcile affected
files with bounded concurrency.

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
