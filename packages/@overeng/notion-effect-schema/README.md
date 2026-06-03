# @overeng/notion-effect-schema

Effect schemas for the Notion API.

## Boundary

`@overeng/notion-effect-schema` owns Effect Schema representations of Notion
wire payloads and the facades that make those schemas ergonomic to consume.
It depends on Effect and may expose decoders, encoders, schema transforms, and
schema-oriented helpers.

Milestone 1 uses the Option B split:

- `@overeng/notion-core` is the intended home for pure dependency-free Notion
  primitives, helpers, tuple builders, and classifiers when that package is
  introduced.
- `@overeng/notion-effect-schema` owns Effect Schema wire schemas and facades.
- `@overeng/notion-effect-client` owns HTTP API services, pagination, retries,
  rate-limit handling, and API error mapping.

Non-goals for this milestone:

- Do not import Effect from `@overeng/notion-core`.
- Do not move `.nmd` contracts into `@overeng/notion-core`.
- Do not move canonical codecs yet; existing codec ownership remains staged.

## Design Decisions

| Aspect          | Decision                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| **Naming**      | Notion terminology (`TitleProperty`, not `TitleElement`)                                                   |
| **Transforms**  | One-level facade: `NotionSchema.title`, `NotionSchema.dateOption`, `NotionSchema.select()`                 |
| **Nullability** | `Schema.Option` for nullable fields, `NotionSchema.required` / `NotionSchema.nullable` to enforce presence |
| **Dates**       | Parsed to `Date` via `Schema.Date`                                                                         |
| **Examples**    | Field-level annotations only                                                                               |
| **Docs**        | Custom `notionDocsUrl` annotation + JSDoc `@see` links                                                     |

## Annotations

Every schema includes:

```ts
import { docsPath } from './common.ts'

.annotations({
  identifier: 'Notion.SchemaName',
  title: 'Human Title',
  description: 'What this represents.',
  [docsPath]: 'property-value-object#title', // path fragment only
})
```

Use `resolveDocsUrl(path)` to get the full URL when needed.

## Updating Schemas

When Notion API changes:

1. Check [Notion API changelog](https://developers.notion.com/changelog)
2. Update affected schemas in `src/`
3. Ensure annotations match new docs URLs
4. Update `CHANGELOG.md`

## File Structure

```
src/
├── mod.ts           # Re-exports
├── common.ts        # IDs, timestamps, colors, notionDocsUrl annotation
├── rich-text.ts     # RichText, Annotations
├── users.ts         # User, Person, Bot
├── properties.ts    # Property value schemas + transforms
├── pages.ts         # Page object
├── databases.ts     # Database object
├── blocks.ts        # Block types
├── comments.ts      # Comment object
└── api/             # Request/response schemas
```

## Reference

- [Notion API Reference](https://developers.notion.com/reference)
- [Property Value Object](https://developers.notion.com/reference/property-value-object)
- [Block Object](https://developers.notion.com/reference/block)
- [Page Object](https://developers.notion.com/reference/page)
- [Database Object](https://developers.notion.com/reference/database)
