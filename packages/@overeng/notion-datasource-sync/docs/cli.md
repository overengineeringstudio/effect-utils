# CLI Reference

The binary is `notion-datasource-sync`.

```sh
notion-datasource-sync init --store <sqlite> --root-id <root> --data-source-id <id> --workspace-root <dir> [--dry-run]
notion-datasource-sync pull --store <sqlite> --root-id <root> --data-source-id <id> --workspace-root <dir>
notion-datasource-sync push --store <sqlite> --root-id <root> --data-source-id <id> --workspace-root <dir> [--dry-run]
notion-datasource-sync sync --store <sqlite> --root-id <root> --data-source-id <id> --workspace-root <dir> [--dry-run]
notion-datasource-sync status --store <sqlite> --root-id <root> --data-source-id <id> --workspace-root <dir>
notion-datasource-sync watch --state <json> --store <sqlite> --root-id <root> --data-source-id <id> --workspace-root <dir> [--max-cycles <n>]
notion-datasource-sync conflicts list --store <sqlite> --root-id <root> --data-source-id <id> --workspace-root <dir>
notion-datasource-sync conflicts resolve --conflict-id <id> --strategy <keep-remote|keep-local|manual> [--value-json <json>] --store <sqlite> --root-id <root> --data-source-id <id> --workspace-root <dir> [--dry-run]
notion-datasource-sync forget --page-id <id> --store <sqlite> --root-id <root> --data-source-id <id> --workspace-root <dir> [--dry-run]
notion-datasource-sync restore --page-id <id> --store <sqlite> --root-id <root> --data-source-id <id> --workspace-root <dir> [--dry-run]
notion-datasource-sync doctor --store <sqlite> --root-id <root> --data-source-id <id> --workspace-root <dir>
```

`migrate store`, `migrate schema`, and `repair` are parsed but currently
unsupported. They fail before doing work.

## Environment

| Variable            | Required | Meaning                                      |
| ------------------- | -------- | -------------------------------------------- |
| `NOTION_API_TOKEN`  | live CLI | Notion integration token                     |
| `NOTION_TOKEN`      | fallback | Legacy token fallback                        |
| `OTEL_*` variables  | optional | OpenTelemetry resource/correlation settings  |

Live E2E and demo variables are documented in [Testing And Demo](./testing.md).

## Shared Flags

| Flag                       | Meaning                                                                  |
| -------------------------- | ------------------------------------------------------------------------ |
| `--store`                  | SQLite store path                                                        |
| `--root-id`                | Local sync root partition                                                |
| `--data-source-id`         | Notion data source id                                                    |
| `--workspace-root`         | Local workspace root                                                     |
| `--query-contract-json`    | Explicit query contract JSON                                             |
| `--schema-properties-json` | Schema-property observations for write planning                          |
| `--required-capabilities`  | Comma-separated capability preflight list                                |
| `--max-executor-steps`     | Bound outbox execution in `push`, `sync`, and `watch`                    |
| `--no-materialize-bodies`  | Observe properties/schema without local body materialization             |

## Commands

| Command             | Effect                                                                 |
| ------------------- | ---------------------------------------------------------------------- |
| `init`              | Records the local root/data-source/workspace binding                   |
| `pull`              | Observes Notion and materializes local state where configured          |
| `push`              | Scans local artifacts, plans writes, and executes the outbox           |
| `sync`              | Runs pull, local scan/planning, outbox execution, and verification      |
| `status`            | Reads the local projections                                            |
| `watch`             | Repeats sync cycles with daemon state and optional max-cycle bound      |
| `conflicts list`    | Prints conflicts, guards, tombstones, and pending outbox actions       |
| `conflicts resolve` | Resolves a conflict by event, optionally planning follow-up commands    |
| `forget`            | Removes local tracking for a page after explicit user intent           |
| `restore`           | Plans restore of a tracked trashed page                                |
| `doctor`            | Aggregates status, compaction readiness, and user-action surfaces       |

## Output

Successful commands print a pretty JSON envelope to stdout:

```json
{
  "_tag": "CliResultEnvelope",
  "version": "v1",
  "command": "status",
  "ok": true,
  "rootId": "workspace-main",
  "status": { "state": "clean" },
  "surface": { "conflicts": [], "guards": [], "tombstones": [], "outbox": [] },
  "result": { "state": "clean" }
}
```

Errors print a JSON envelope to stderr:

```json
{
  "_tag": "CliErrorEnvelope",
  "version": "v1",
  "ok": false,
  "error": {
    "_tag": "CliArgumentError",
    "message": "Missing required --store"
  }
}
```

Treat command output as operational data. It can include page ids, data-source
ids, and local paths.
