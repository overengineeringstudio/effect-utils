# @overeng/notion-core

Pure dependency-free Notion primitives and helpers.

## What It Provides

- Notion API and docs constants.
- UUID parsing, formatting, compaction, and object URL helpers.
- Color and property-type tuples with TypeScript literal types.
- Property write-class classification.
- Lightweight rich-text plain-text extraction for raw Notion payloads.

## Usage

```ts
import {
  NOTION_API_VERSION,
  parseNotionUuid,
  propertyWriteClassFromType,
} from '@overeng/notion-core'

const pageId = parseNotionUuid('https://www.notion.so/example/0123456789abcdef0123456789abcdef')
const writeClass = propertyWriteClassFromType('formula')
```

See [docs/spec.md](./docs/spec.md) for package-boundary details.
