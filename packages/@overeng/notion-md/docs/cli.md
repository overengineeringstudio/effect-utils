# CLI Reference

The binary is `notion-md`.

```sh
notion-md sync <page-id-or-url> <file.nmd>
notion-md sync <file.nmd>
notion-md sync <dir> --from-remote --root <page-id-or-url> [--root-file index.nmd]
notion-md plan <dir> [--root <page-id-or-url>] [--from-remote]
notion-md sync <dir> [--root <page-id-or-url>]
notion-md sync <dir> --recursive [--concurrency <n>]
notion-md status <target...> [--recursive] [--concurrency <n>]
```

## Environment

| Variable                                  | Required | Meaning                                           |
| ----------------------------------------- | -------- | ------------------------------------------------- |
| `NOTION_API_TOKEN`                        | yes      | Notion API token                                  |
| `NOTION_MD_TEST_PARENT_PAGE_ID_ALLOWLIST` | live e2e | Comma-separated parent page ids cleanup may touch |

## Modes

The public contract has three modes:

| Mode           | Command                                                      | Meaning                                                           |
| -------------- | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| Single page    | `notion-md sync <page-id-or-url> <file.nmd>`                 | Import one Notion page into one local file                        |
| Single page    | `notion-md sync <file.nmd>`                                  | Reconcile one bound file                                          |
| Directory tree | `notion-md sync <dir> --from-remote --root <page-id-or-url>` | Import or refresh a Notion subtree into deterministic local paths |
| Directory tree | `notion-md plan <dir>`                                       | Preview create/update/move/trash/noop operations                  |
| Directory tree | `notion-md sync <dir>`                                       | Apply the local directory as desired tree state                   |
| Flat batch     | `notion-md sync <dir> --recursive --concurrency 4`           | Reconcile existing `.nmd` files independently                     |

`--recursive` is not tree sync. It never implies hierarchy, child
materialization, moves, or trashing pages missing locally.

## `sync <page> <file.nmd>`

```sh
notion-md sync <page-id-or-url> <file.nmd>
```

With a Notion page id or URL plus a local file target, `sync` establishes local
sync state for one page. Directory tree materialization uses the explicit
tree-first form:

```sh
notion-md sync <dir> --from-remote --root <page-id-or-url>
```

## Directory Tree

```sh
notion-md sync docs --from-remote --root <page-id-or-url> [--root-file index.nmd]
notion-md plan docs
notion-md sync docs
```

A directory tree treats local files and paths as the desired Notion subtree.
Remote-authoritative import uses `--from-remote`; local-authoritative sync is
the default.

The tree engine writes `<dir>/.notion-md/workspace.json` as an internal tree
index containing the root page id, root file, and page path map. Users should
treat it as sync state and commit it with the tree if the tree is versioned.

For parent pages without authored child anchors, tree sync derives one
block-level `<page>` anchor for every local child. If a parent body already
contains block-level `<page>` anchors, tree sync treats that block as authored
content: it preserves anchor placement and interleaved annotations, but fails if
a local child is missing an anchor, has duplicate anchors, or an anchor points
outside the local child set.

For new `page_id: null` children under an authored index, write a URL-less
placeholder anchor such as `<page>New child page</page>` in the desired
position. After creating the child page, tree sync fills the pushed Notion body
with the new page URL while keeping the local authored index shape intact.

To add a new local page to a tree, create a `.nmd` file with `page_id: null` and
a valid `parent` reference. The parent reference is required even before the
page exists remotely; it lets the tree engine validate intent before creating
the Notion page.

```json
{
  "notion_md": {
    "version": 2,
    "api_version": "2026-03-11",
    "object": "page",
    "page_id": null,
    "url": null,
    "parent": { "_tag": "page", "id": "<parent-page-id>" },
    "page": {
      "title": "New child page",
      "icon": null,
      "cover": null,
      "in_trash": false,
      "is_locked": false
    },
    "properties": {}
  }
}
```

`plan` reports these as create operations without remote identity. Applied
`sync` create operations include the new `pageId` and `url` in JSON output, and
also write them back into the `.nmd` frontmatter.

## Targets

`status` accepts one or more file targets. Passing a single file emits a
single-page JSON result. Passing multiple files, or a directory with
`--recursive`, emits a batch result envelope. Passing one directory without
`--recursive` uses directory tree mode.

Flat batch discovery walks nested directories, finds existing `*.nmd` files, and
skips `.notion-md`, `.git`, and `node_modules`.

Batch options:

| Option          | Default | Meaning                                                |
| --------------- | ------- | ------------------------------------------------------ |
| `--recursive`   | `false` | Discover existing `.nmd` files under directory targets |
| `--concurrency` | `4`     | Maximum number of files reconciled at the same time    |

Before mutating Notion, batch runs parse the candidate files and reject duplicate
`page_id` values in the same batch. Each `.nmd` still syncs through the same
guarded one-page engine as single-file commands.

## `plan`

```sh
notion-md plan <dir>
```

Prints the directory tree diff without applying it. File targets are rejected;
use `notion-md status <file.nmd>` for one bound file.

## `status`

```sh
notion-md status <target...>
```

Reads local files, validates all referenced objects, pulls remote state, and
prints JSON status results.

For directory trees, `status` uses the same dry-run tree model as `plan` and
reports missing local files without materializing them.

Use this before a sync when you want to know whether the local file, remote page,
or both have changed.

## `sync`

```sh
notion-md sync <target>
```

Runs one reconciliation pass for a local file or local directory tree.

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
One file target emits one-file watch events. Multiple files or flat recursive
directory targets use a batch watch envelope and reconcile affected files with
bounded concurrency.

Directory tree watch is not implemented yet. Run one-shot
`notion-md sync <dir>` periodically, or watch specific `.nmd` files /
flat recursive directories when you need a long-running process.

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
