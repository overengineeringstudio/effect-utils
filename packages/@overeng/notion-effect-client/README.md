# @overeng/notion-effect-client

Effect-native HTTP client for the Notion API.

## Installation

```bash
bun add @overeng/notion-effect-client
```

## Usage

```ts
import { Effect, Layer } from 'effect'
import { HttpClient } from '@effect/platform'
import { NodeHttpClient } from '@effect/platform-node'
import { NotionConfigLive, NotionDatabases, NotionPages } from '@overeng/notion-effect-client'

const program = Effect.gen(function* () {
  // Query a database
  const results = yield* NotionDatabases.query({
    databaseId: 'abc-123',
  })

  // Retrieve a page
  const page = yield* NotionPages.retrieve({
    pageId: results.results[0].id,
  })

  return page
})

const MainLayer = Layer.mergeAll(
  NotionConfigLive({ authToken: process.env.NOTION_TOKEN! }),
  NodeHttpClient.layer,
)

program.pipe(Effect.provide(MainLayer), Effect.runPromise)
```

## API

### Databases

```ts
import { NotionDatabases } from '@overeng/notion-effect-client'

// Retrieve database metadata
const db = yield * NotionDatabases.retrieve({ databaseId: '...' })

// Query with filters and sorts
const results =
  yield *
  NotionDatabases.query({
    databaseId: '...',
    filter: { property: 'Status', select: { equals: 'Done' } },
    sorts: [{ property: 'Created', direction: 'descending' }],
  })

// Stream all pages with automatic pagination
const allPages = yield * NotionDatabases.queryStream({ databaseId: '...' }).pipe(Stream.runCollect)

// Query with typed schema decoding
import { Schema } from 'effect'
import { Title, Select } from '@overeng/notion-effect-schema'

const TaskSchema = Schema.Struct({
  Name: Title.asString,
  Status: Select.asOption,
})

const typed =
  yield *
  NotionDatabases.query({
    databaseId: '...',
    schema: TaskSchema,
  })
// typed.results[0].properties.Name is string
```

### Pages

```ts
import { NotionPages } from '@overeng/notion-effect-client'

// Retrieve a page
const page = yield * NotionPages.retrieve({ pageId: '...' })

// Create a page in a database
const newPage =
  yield *
  NotionPages.create({
    parent: { type: 'database_id', database_id: '...' },
    properties: {
      Name: { title: [{ text: { content: 'New Task' } }] },
    },
  })

// Update page properties
yield *
  NotionPages.update({
    pageId: '...',
    properties: { Status: { select: { name: 'Done' } } },
  })

// Archive a page
yield * NotionPages.archive({ pageId: '...' })
```

### Blocks

```ts
import { NotionBlocks } from '@overeng/notion-effect-client'

// Retrieve a block
const block = yield * NotionBlocks.retrieve({ blockId: '...' })

// Get block children
const children = yield * NotionBlocks.retrieveChildren({ blockId: '...' })

// Stream all children with automatic pagination
const allChildren =
  yield * NotionBlocks.retrieveChildrenStream({ blockId: '...' }).pipe(Stream.runCollect)

// Append children blocks
yield *
  NotionBlocks.append({
    blockId: '...',
    children: [{ type: 'paragraph', paragraph: { rich_text: [{ text: { content: 'Hello' } }] } }],
  })

// Retrieve nested blocks as a tree
const tree =
  yield *
  NotionBlocks.retrieveAsTree({
    blockId: pageId,
    maxDepth: 10,
  })

// Retrieve nested blocks as a flat stream with depth info
const blocks =
  yield *
  NotionBlocks.retrieveAllNested({ blockId: pageId }).pipe(
    Stream.runForEach((item) => Effect.log(`${'  '.repeat(item.depth)}${item.block.type}`)),
  )
```

### Markdown Conversion

```ts
import { NotionMarkdown, BlockHelpers, getBlockUrl } from '@overeng/notion-effect-client'
import { RichTextUtils } from '@overeng/notion-effect-schema'

// Convert a page to markdown
const markdown = yield * NotionMarkdown.pageToMarkdown({ pageId: '...' })

// Convert with custom transformers
const markdown =
  yield *
  NotionMarkdown.pageToMarkdown({
    pageId: '...',
    transformers: {
      image: (block) => {
        const url = getBlockUrl(block)
        const caption = RichTextUtils.toPlainText(BlockHelpers.getCaption(block))
        return url ? `<Image src="${url}" alt="${caption}" />` : ''
      },
    },
  })

// Convert a pre-fetched block tree
const tree = yield * NotionBlocks.retrieveAsTree({ blockId: pageId })
const markdown = yield * NotionMarkdown.treeToMarkdown({ tree })
```

### Search

```ts
import { NotionSearch } from '@overeng/notion-effect-client'

// Search pages and databases
const results =
  yield *
  NotionSearch.search({
    query: 'meeting notes',
    filter: { property: 'object', value: 'page' },
  })

// Stream all search results
const allResults = yield * NotionSearch.searchStream({ query: 'project' }).pipe(Stream.runCollect)
```

### Users

```ts
import { NotionUsers } from '@overeng/notion-effect-client'

// Get current bot user
const bot = yield * NotionUsers.me()

// Retrieve a user
const user = yield * NotionUsers.retrieve({ userId: '...' })

// List all users
const users = yield * NotionUsers.list()

// Stream all users
const allUsers = yield * NotionUsers.listStream().pipe(Stream.runCollect)
```

## Configuration

```ts
import { NotionConfigLive } from '@overeng/notion-effect-client'

const config = NotionConfigLive({
  authToken: 'secret_xxx',
  retryEnabled: true, // default: true
  maxRetries: 3, // default: 3
  retryBaseDelay: 1000, // default: 1000ms
})
```

## Error Handling

All API errors are returned as `NotionApiError` with structured error information:

```ts
import { NotionApiError, NotionErrorCode } from '@overeng/notion-effect-client'

const result =
  yield *
  NotionPages.retrieve({ pageId: '...' }).pipe(
    Effect.catchTag('NotionApiError', (error) => {
      if (error.code === NotionErrorCode.ObjectNotFound) {
        return Effect.succeed(null)
      }
      return Effect.fail(error)
    }),
  )
```
