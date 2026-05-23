# CLI Reference

The binary is `notion-md`.

```sh
notion-md pull <page-id> --out <file.nmd>
notion-md status <file.nmd>
notion-md push <file.nmd> [--force] [--allow-delete-unknown-blocks] [--allow-review-markup]
notion-md sync <file.nmd> [--watch] [--poll-interval-ms <ms>] [--force] [--allow-delete-unknown-blocks] [--allow-review-markup]
```

## Environment

| Variable           | Required | Meaning                    |
| ------------------ | -------- | -------------------------- |
| `NOTION_TOKEN`     | yes      | Preferred Notion API token |
| `NOTION_API_TOKEN` | fallback | Legacy token variable      |

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

## `status`

```sh
notion-md status <file.nmd>
```

Reads the local file, validates all referenced objects, pulls remote state, and
prints a JSON status result.

Use this before a push when you want to know whether the local file, remote page,
or both have changed.

## `push`

```sh
notion-md push <file.nmd>
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
notion-md sync <file.nmd>
```

Runs one pull-or-push reconciliation pass. It uses the same safety flags as
`push`.

## `sync --watch`

```sh
notion-md sync <file.nmd> --watch --poll-interval-ms 30000
```

Runs continuous one-file sync. Local file events and remote poll events are
coalesced, and only one sync pass runs at a time.

Options:

| Option               | Default | Meaning                                 |
| -------------------- | ------- | --------------------------------------- |
| `--watch`            | `false` | Keep syncing after local or remote cues |
| `--poll-interval-ms` | `30000` | Remote polling interval in milliseconds |

## Output

One-shot commands print pretty JSON. Watch mode prints newline-delimited compact
JSON events.

Watch event examples:

```json
{"event":"sync","reason":"file","result":{"_tag":"pushed"}}
{"event":"sync_error","reason":"poll","error":{"_tag":"NmdConflictError","message":"Remote page changed since the last clean pull"}}
```

The exact stable output envelope is still a design question. Treat command
output as operational signal for now, not a public machine contract.
