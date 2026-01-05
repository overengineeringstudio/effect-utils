# @overeng/notion-effect-cli

CLI and library for generating type-safe [Effect](https://effect.website) schemas from Notion databases.

## Installation

```bash
pnpm add @overeng/notion-effect-cli
```

## Quick Start

### Prerequisites

1. Create a [Notion integration](https://www.notion.so/my-integrations) and copy the "Internal Integration Secret"
2. Share your database with the integration (open database → "..." menu → "Connections" → add your integration)

### Generate a Schema

```bash
# Set your Notion API token
export NOTION_TOKEN="secret_..."

# Generate schema for a database
notion-effect-cli generate <database-id> -o ./src/schemas/tasks.ts
```

This produces a fully typed Effect schema that works with `@overeng/notion-effect-client`:

```ts
// Generated file: tasks.ts
import { Schema } from 'effect'
import { Title, Status, DateProp } from '@overeng/notion-effect-schema'

export const TasksPageProperties = Schema.Struct({
  Name: Title.asString,
  Status: Status.asOption,
  'Due Date': DateProp.asOption,
})

export type TasksPageProperties = typeof TasksPageProperties.Type
```

## CLI Commands

### `generate`

Generate a schema from a single database:

```bash
notion-effect-cli generate <database-id> -o <output-file> [options]
```

| Option                | Description                                           |
| --------------------- | ----------------------------------------------------- |
| `-o, --output`        | Output file path (required)                           |
| `-n, --name`          | Custom schema name (defaults to database title)       |
| `-t, --token`         | Notion API token (defaults to `NOTION_TOKEN` env var) |
| `-w, --include-write` | Generate write schemas for creating/updating pages    |
| `-a, --include-api`   | Generate a typed API wrapper                          |
| `--typed-options`     | Generate literal unions for select/status options     |
| `--transform`         | Property transform config (e.g., `Status=asString`)   |
| `-d, --dry-run`       | Preview generated code without writing                |

### `introspect`

Inspect a database's schema:

```bash
notion-effect-cli introspect <database-id>
```

Outputs property names, types, and available options.

### `generate-config`

Generate schemas for multiple databases from a config file:

```bash
notion-effect-cli generate-config [-c <config-file>]
```

### `diff`

Detect schema drift between a live Notion database and an existing generated schema file:

```bash
notion-effect-cli diff <database-id> --file ./src/schemas/tasks.ts
```

Use `--exit-code` to exit with code `1` when differences are found (useful for CI):

```bash
notion-effect-cli diff <database-id> --file ./src/schemas/tasks.ts --exit-code
```

Example output:

```text
Comparing database abc123... with ./src/schemas/tasks.ts

Database ID matches

Changes detected:
  + NewField (rich_text) - new property in Notion
  - OldField (select) - removed from Notion
  ~ Status: type changed (select -> status)

Summary: 1 added, 1 removed, 1 type changed
```

## Config File

For multi-database projects, create `.notion-schema-gen.json`:

```json
{
  "defaults": {
    "includeWrite": true,
    "includeApi": true
  },
  "databases": [
    {
      "id": "abc123...",
      "output": "./src/schemas/tasks.ts",
      "name": "Tasks"
    },
    {
      "id": "def456...",
      "output": "./src/schemas/projects.ts",
      "name": "Projects",
      "typedOptions": true
    }
  ]
}
```

Config discovery starts from `CurrentWorkingDirectory` (defaults to the process CWD).
When using the programmatic API, you can override it with `CurrentWorkingDirectory.fromPath`.

## Usage with notion-effect-client

### Basic Query

```ts
import { Effect, Layer, Stream } from 'effect'
import { FetchHttpClient } from '@effect/platform'
import { NotionConfigLive, NotionDatabases } from '@overeng/notion-effect-client'
import { TasksPageProperties } from './schemas/tasks.ts'

const program = Effect.gen(function* () {
  // Query with automatic type decoding
  const pages = yield* NotionDatabases.queryStream({
    databaseId: 'abc123...',
    schema: TasksPageProperties,
  }).pipe(Stream.runCollect)

  for (const page of pages) {
    // page.properties is typed as TasksPageProperties
    console.log(page.properties.Name) // string
    console.log(page.properties.Status) // Option<string>
  }
})

const MainLayer = Layer.mergeAll(
  NotionConfigLive({ authToken: process.env.NOTION_TOKEN! }),
  FetchHttpClient.layer,
)

program.pipe(Effect.provide(MainLayer), Effect.runPromise)
```

### With Generated API Wrapper

When using `--include-api`, a typed API module is generated alongside the schema:

```bash
notion-effect-cli generate <db-id> -o ./src/schemas/tasks.ts --include-api
```

This creates `tasks.ts` (schema) and `tasks.api.ts` (API wrapper):

```ts
import { Effect, Layer } from 'effect'
import { FetchHttpClient } from '@effect/platform'
import { NotionConfigLive } from '@overeng/notion-effect-client'
import * as TasksApi from './schemas/tasks.api.ts'

const program = Effect.gen(function* () {
  // Query all pages
  const pages = yield* TasksApi.queryAll()

  // Get a single page
  const page = yield* TasksApi.get('page-id')

  // Create a new page (requires --include-write)
  yield* TasksApi.create({
    Name: 'New Task',
    Status: 'In Progress',
  })

  // Update a page
  yield* TasksApi.update('page-id', {
    Status: 'Done',
  })

  // Archive a page
  yield* TasksApi.archive('page-id')
})

const MainLayer = Layer.mergeAll(
  NotionConfigLive({ authToken: process.env.NOTION_TOKEN! }),
  FetchHttpClient.layer,
)

program.pipe(Effect.provide(MainLayer), Effect.runPromise)
```

### Creating/Updating Pages

With `--include-write`, a write schema is generated for creating and updating pages:

```ts
import { Effect } from 'effect'
import { NotionPages } from '@overeng/notion-effect-client'
import { TasksPageWrite, encodeTasksWrite } from './schemas/tasks.ts'

const program = Effect.gen(function* () {
  // Create a new page
  yield* NotionPages.create({
    parent: { type: 'database_id', database_id: 'abc123...' },
    properties: encodeTasksWrite({
      Name: 'New Task',
      Status: 'Not Started',
      'Due Date': new Date('2025-01-15'),
    }),
  })
})
```

## Property Transforms

Transforms control how Notion property types are decoded. Each property type has a default transform and available alternatives:

| Property Type  | Default     | Available Transforms          |
| -------------- | ----------- | ----------------------------- |
| `title`        | `asString`  | `raw`, `asString`             |
| `rich_text`    | `asString`  | `raw`, `asString`             |
| `number`       | `asNumber`  | `raw`, `asNumber`, `asOption` |
| `select`       | `asOption`  | `raw`, `asOption`, `asString` |
| `multi_select` | `asStrings` | `raw`, `asStrings`            |
| `status`       | `asOption`  | `raw`, `asOption`, `asString` |
| `date`         | `asOption`  | `raw`, `asDate`, `asOption`   |
| `checkbox`     | `asBoolean` | `raw`, `asBoolean`            |
| `url`          | `asOption`  | `raw`, `asString`, `asOption` |
| `relation`     | `asIds`     | `raw`, `asIds`                |

Override transforms via CLI:

```bash
notion-effect-schema-gen generate <db-id> -o ./out.ts \
  --transform Status=asString \
  --transform Priority=raw
```

Or in config:

```json
{
  "databases": [{
    "id": "...",
    "output": "./schema.ts",
    "transforms": {
      "Status": "asString",
      "Priority": "raw"
    }
  }]
}
```

## Programmatic Usage

```ts
import { Effect, Layer } from 'effect'
import { FetchHttpClient, NodeContext } from '@effect/platform-node'
import { NotionConfigLive } from '@overeng/notion-effect-client'
import { CurrentWorkingDirectory } from '@overeng/utils/node'
import {
  introspectDatabase,
  generateSchemaCode,
  formatCode,
} from '@overeng/notion-effect-cli'

const program = Effect.gen(function* () {
  const dbInfo = yield* introspectDatabase('abc123...')

  const code = generateSchemaCode(dbInfo, 'Tasks', {
    includeWrite: true,
    typedOptions: true,
    transforms: { Status: 'asString' },
  })

  const formatted = yield* formatCode(code)
  console.log(formatted)
})

const MainLayer = Layer.mergeAll(
  NotionConfigLive({ authToken: process.env.NOTION_TOKEN! }),
  FetchHttpClient.layer,
  NodeContext.layer,
  CurrentWorkingDirectory.live,
)

program.pipe(Effect.provide(MainLayer), Effect.runPromise)
```

## Related Packages

- [`@overeng/notion-effect-client`](../notion-effect-client) - Effect-native Notion API client
- [`@overeng/notion-effect-schema`](../notion-effect-schema) - Effect schemas for Notion property types
