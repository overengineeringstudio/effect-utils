# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Changed

- TypeScript builds now emit ESM JavaScript to `dist/` with source maps and declaration maps.
- Property “read” transforms are now decode-only; write payloads are modeled separately via `*Write` schemas / transforms.
- Notion HTTP client retry behavior:
  - Treats request-body JSON encoding failures as typed `NotionApiError` (instead of defects).
  - Respects `retry-after` on 429 responses when retrying.
- Updated dependencies to latest versions (effect ^3.19.13, @effect/platform ^0.94.0)

### Added

- **@schickling/notion-effect-schema-gen**: Full CLI implementation for schema generation
  - `generate` subcommand: Introspects a Notion database and generates Effect schemas
    - `--output` / `-o`: Output file path for generated schema
    - `--name` / `-n`: Custom name for the generated schema (defaults to database title)
    - `--token` / `-t`: Notion API token (defaults to NOTION_TOKEN env var)
    - `--transform`: Per-property transform configuration (e.g., `Status=raw`)
    - `--dry-run` / `-d`: Preview generated code without writing to file
    - `--include-write` / `-w`: Include Write schemas for creating/updating pages
    - `--typed-options`: Generate typed literal unions for select/status options
  - `introspect` subcommand: Displays database schema information
  - Config file support (`.notion-schema-gen.json`) for multi-database projects
  - Configurable property transforms per type (raw, asString, asOption, asNumber, etc.)
  - Support for all 21 Notion property types with sensible defaults
  - Improved PascalCase handling that preserves existing casing
  - Auto-formatting with Biome when available
  - Uses Effect FileSystem and Path for file operations
  - Generated code includes proper Effect Schema imports and type exports
  - Comprehensive unit tests for code generation functionality

- **@schickling/notion-effect-schema**: Core Notion object schemas
  - `Database`, `Page`, `Block` with full field definitions
  - Parent types: `DatabaseParent`, `PageParent`, `BlockParent`
  - File objects: `ExternalFile`, `NotionFile`, `FileObject`
  - Icon types: `EmojiIcon`, `CustomEmojiIcon`, `Icon`
  - Block type enum covering all 27 Notion block types
  - `DataSource` for database data sources

- **@schickling/notion-effect-schema**: Comprehensive Effect schemas
  - Foundation schemas: `NotionUUID`, `ISO8601DateTime`, `NotionColor`, `SelectColor`
  - Rich text support: `RichText`, `TextAnnotations`, `MentionRichText`, `EquationRichText`
  - User schemas: `Person`, `Bot`, `PartialUser`, `User` union
  - Property schemas with:
    - decode transforms (e.g. `Title.asString`, `Num.asNumber`, `Select.asStringRequired`)
    - write payload schemas/transforms for page create/update (e.g. `TitleWrite`, `SelectWrite`, `PeopleWrite`)
  - Custom `docsPath` annotation linking each schema to official Notion API docs
  - Proper Effect `Option` handling for nullable/optional fields

- **@schickling/notion-effect-client**: Comprehensive test suite with real API integration
  - Unit tests for internal HTTP utilities
    - `parseRateLimitHeaders`, `buildRequest`, `get`, `post` functions
    - `NotionApiError.isRetryable` logic
    - Pagination utilities: `paginationParams`, `toPaginatedResult`, `paginatedStream`
  - Integration tests for service modules (skipped when no token)
    - Databases: `retrieve`, `query`, `queryStream` with filters and pagination
    - Pages: `retrieve`, `create`, `update`, `archive`
    - Blocks: `retrieve`, `retrieveChildren`, `retrieveChildrenStream`, `append`, `update`, `delete`
    - Users: `me`, `list`, `listStream`, `retrieve`
    - Search: `search`, `searchStream` with filters and sorting
  - `describe.skipIf` pattern for graceful skipping when no API token
  - Separate `test:unit` and `test:integration` npm scripts

## [0.1.0] - 2025-08-03

Initial release of effect-notion monorepo.

### Added

- **@schickling/notion-effect-schema**: Effect schemas for the Notion HTTP API
- **@schickling/notion-effect-client**: Effect-native HTTP client for the Notion API
- **@schickling/notion-effect-schema-gen**: CLI tool for schema generation

### Infrastructure

- Initial monorepo setup with pnpm workspaces
- TypeScript configuration with project references
- Modern ESM-first package structure
