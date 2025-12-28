# effect-notion

[Effect](https://effect.website) schemas and tools for working with the Notion API.

Uses the [Notion HTTP API](https://developers.notion.com/reference) directly via `@effect/platform` HttpClient (no dependency on `@notionhq/client`).

## Packages

### [@schickling/notion-effect-client](./packages/@schickling/notion-effect-client)

Effect-native HTTP client for the Notion API with proper error handling, automatic pagination, and observability.

```ts
import { Effect, Layer } from 'effect'
import { FetchHttpClient } from '@effect/platform'
import { NotionConfigLive, NotionDatabases, NotionPages } from '@schickling/notion-effect-client'

const program = Effect.gen(function* () {
  // Query a database with automatic pagination
  const result = yield* NotionDatabases.query({
    databaseId: 'your-database-id',
    filter: { property: 'Status', select: { equals: 'active' } },
  })

  // Or use streaming for large datasets
  const allPages = yield* NotionDatabases.queryStream({
    databaseId: 'your-database-id',
  }).pipe(Stream.runCollect)

  // Create a page
  const page = yield* NotionPages.create({
    parent: { type: 'database_id', database_id: 'your-database-id' },
    properties: {
      Name: { title: [{ text: { content: 'New Task' } }] },
    },
  })

  return { result, page }
})

const MainLayer = Layer.mergeAll(
  NotionConfigLive({ authToken: process.env.NOTION_TOKEN! }),
  FetchHttpClient.layer,
)

program.pipe(Effect.provide(MainLayer), Effect.runPromise)
```

### [@schickling/notion-effect-schema](./packages/@schickling/notion-effect-schema)

Effect schemas for Notion API property types with convenient transform variants.

```ts
import { Schema } from 'effect'
import { Title, Checkbox, Select, DateProp } from '@schickling/notion-effect-schema'

// Parse raw Notion properties
const rawTitle = Title.raw  // Full Notion title structure
const titleString = Title.asString  // Extracts plain text

// Transform to clean types
const isComplete = Checkbox.asBoolean  // boolean
const status = Select.asOption  // Option<string>
const dueDate = DateProp.asDate  // Option<Date>
```

### [@schickling/notion-effect-schema-gen](./packages/@schickling/notion-effect-schema-gen)

CLI tool to introspect Notion database schemas and generate corresponding Effect schemas.

```bash
# Generate Effect schema from Notion database
notion-effect-schema-gen <database-id> > generated-schema.ts
```

## Development

```bash
pnpm install
pnpm build
pnpm test
```

### Running tests

```bash
# Unit tests only
pnpm test:unit

# Integration tests (requires NOTION_TOKEN)
NOTION_TOKEN=secret_xxx pnpm test:integration

# All tests
NOTION_TOKEN=secret_xxx pnpm test
```
