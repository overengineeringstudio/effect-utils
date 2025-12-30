# Architecture

This document describes the package structure, design patterns, and development workflows for the effect-notion monorepo.

## Package Dependency Diagram

```
                    ┌─────────────────────────────────┐
                    │ notion-effect-schema            │
                    │ (Foundation: Schemas)           │
                    └────────────┬────────────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────────────┐
                    │ notion-effect-client            │
                    │ (HTTP client using schemas)     │
                    └────────────┬────────────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────────────┐
                    │ notion-effect-schema-gen        │
                    │ (CLI using client + schemas)    │
                    └─────────────────────────────────┘


                    ┌─────────────────────────────────┐
                    │ effect-schema-form              │
                    │ (Standalone: Headless forms)    │
                    └────────────┬────────────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────────────┐
                    │ effect-schema-form-aria         │
                    │ (React Aria UI implementation)  │
                    └─────────────────────────────────┘
```

## Package Descriptions

### @schickling/notion-effect-schema

**Purpose**: Core Effect schemas for all Notion API types.

**Key Files**:
- `src/properties.ts`: Property value schemas with read/write transforms
- `src/objects.ts`: Database, Page, Block schemas
- `src/users.ts`: User and Person schemas
- `src/rich-text.ts`: Rich text content schemas
- `src/common.ts`: Foundation types and utilities

**Dependencies**: `effect` only

### @schickling/notion-effect-client

**Purpose**: Effect-native HTTP client for the Notion API.

**Key Files**:
- `src/databases.ts`: Database query/retrieve operations
- `src/pages.ts`: Page CRUD operations
- `src/blocks.ts`: Block operations
- `src/users.ts`: User list/retrieve operations
- `src/search.ts`: Search API
- `src/internal/http.ts`: HTTP utilities
- `src/internal/pagination.ts`: Pagination helpers

**Dependencies**: `notion-effect-schema`, `@effect/platform`, `effect`

### @schickling/notion-effect-schema-gen

**Purpose**: CLI tool to generate typed Effect schemas from Notion databases.

**CLI Commands**:
- `generate <database-id>`: Generate schema for a database
- `introspect <database-id>`: Display database schema info
- `generate-config`: Generate schemas from config file

**CLI Options**:
- `--output` / `-o`: Output file path
- `--name` / `-n`: Custom schema name
- `--include-write` / `-w`: Include Write schemas
- `--typed-options`: Generate typed literal unions
- `--dry-run` / `-d`: Preview without writing

### @schickling/effect-schema-form

**Purpose**: Headless schema-driven form library for React.

**Key Files**:
- `src/introspection.ts`: Schema analysis and field type detection
- `src/hooks.ts`: `useSchemaForm` hook
- `src/types.ts`: Type definitions

### @schickling/effect-schema-form-aria

**Purpose**: Pre-styled React Aria implementation.

**Components**: `AriaSchemaForm`, `TextField`, `NumberField`, `BooleanField`, `LiteralField`

## Key Design Patterns

### Schema Transform Namespace Pattern

Each Notion property type has multiple transform variants:

```typescript
// Read transforms (decode-only)
Title.raw          // Full Notion title structure
Title.asString     // Extracts plain text string

Num.raw            // Full number property structure
Num.asNumber       // Extracts number value
Num.asOption       // Extracts Option<number>

// Write transforms (for create/update operations)
Title.Write.fromString      // string -> TitleWrite
Select.Write.fromName       // string -> SelectWrite
Num.Write.fromNumber        // number -> NumberWrite
```

### Read vs Write Schema Separation

**Read Schemas**: Full property structures returned by the API
- Include metadata: `id`, `type`, full nested objects
- Example: `TitleProperty`, `SelectProperty`

**Write Schemas**: Minimal payloads for create/update
- Exclude metadata
- Example: `TitleWrite`, `SelectWrite`

### Effect Service Pattern

```typescript
import { NotionDatabases, NotionPages } from '@schickling/notion-effect-client'

const program = Effect.gen(function* () {
  const database = yield* NotionDatabases.retrieve({ databaseId: 'xxx' })
  const page = yield* NotionPages.create({ ... })
})

const MainLayer = Layer.mergeAll(
  NotionConfigLive({ authToken: process.env.NOTION_TOKEN! }),
  FetchHttpClient.layer,
)

program.pipe(Effect.provide(MainLayer), Effect.runPromise)
```

## Data Flow

### Read: Notion API → Client → User Code

```
Notion API Response (JSON)
         │
         ▼
notion-effect-client decodes via Schema
         │
         ▼
User receives typed Effect<Page, NotionApiError>
         │
         ▼
User applies property transforms
         │
         ▼
Clean typed data (string, number, Option<Date>)
```

### Write: User Code → Client → Notion API

```
User provides clean data (string, number, etc.)
         │
         ▼
Transform to Write schema
         │
         ▼
notion-effect-client encodes to JSON
         │
         ▼
Notion API receives create/update request
```

## Development Workflow

### Setup

```bash
pnpm install
pnpm build
pnpm typecheck
```

### Running Tests

```bash
# All tests
NOTION_TOKEN=secret_xxx pnpm test

# Unit tests only
pnpm test:unit

# Package-specific
cd packages/@schickling/notion-effect-client
pnpm test
```

### Using schema-gen CLI

```bash
NOTION_TOKEN=secret_xxx node dist/cli.js generate <database-id> \
  --output generated-schema.ts \
  --name MyDatabase \
  --include-write \
  --typed-options
```

## Error Handling

All client operations return `Effect<T, NotionApiError>`:

```typescript
const program = NotionPages.retrieve({ pageId: 'xxx' }).pipe(
  Effect.catchTag('NotionApiError', (error) =>
    Effect.logError(`API error: ${error.message} (${error.status})`),
  ),
)
```

**Retry Logic**:
- Retryable: 429 (rate limit), 500, 502, 503, 504
- Non-retryable: 400, 401, 403, 404
- Respects `retry-after` header

## Testing Strategy

### Unit Tests
- Schema encoding/decoding
- Code generation logic
- HTTP utilities

### Integration Tests
- Real Notion API calls (requires `NOTION_TOKEN`)
- Uses `describe.skipIf` for graceful skipping

```typescript
const hasToken = !!process.env.NOTION_TOKEN

describe.skipIf(!hasToken)('NotionPages integration', () => {
  it('should retrieve a page', () => { ... })
})
```

## Best Practices

### Schema Design
- Always decode unknown data with schemas
- Use transform variants for common use cases
- Separate read and write schemas

### Error Handling
- Use tagged errors for expected errors
- Never use `any` for error channel

### Service Design
- Use Effect.Service pattern for dependency injection
- Add spans to all meaningful effects
