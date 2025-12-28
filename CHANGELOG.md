# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - 2025-08-03

Initial release of effect-notion monorepo.

### Added

- **@schickling/notion-effect-schema**: Effect schemas for Notion API primitives
  - `TitleElement`, `CheckboxElement`, `SelectElement` and other property type schemas
  - Transform schemas: `StringFromTitleElement`, `BooleanFromCheckboxElement`, `StringFromSelectElement`
- **@schickling/notion-effect-client**: Effect-native wrapper for Notion API
  - `NotionClient` service with proper error handling and observability
- **@schickling/notion-effect-schema-gen**: CLI tool for schema generation
  - Introspect Notion database schemas and generate Effect schemas

### Changed

- Updated package.json exports structure for modern ESM development workflow
- Added detailed package descriptions with usage examples to README

### Infrastructure

- Initial monorepo setup with pnpm workspaces
- TypeScript configuration with project references
- Modern ESM-first package structure

## [Unreleased]

### Changed

- Updated dependencies to latest versions (effect ^3.19.13, @effect/platform ^0.94.0)

### Added

- **@schickling/notion-effect-schema**: Core Notion object schemas
  - `Database`, `Page`, `Block` with full field definitions
  - Parent types: `DatabaseParent`, `PageParent`, `BlockParent`
  - File objects: `ExternalFile`, `NotionFile`, `FileObject`
  - Icon types: `EmojiIcon`, `CustomEmojiIcon`, `Icon`
  - Block type enum covering all 27 Notion block types
  - `DataSource` for database data sources

- **@schickling/notion-effect-schema**: Complete rewrite with comprehensive Effect schemas
  - Foundation schemas: `NotionUUID`, `ISO8601DateTime`, `NotionColor`, `SelectColor`
  - Rich text support: `RichText`, `TextAnnotations`, `MentionRichText`, `EquationRichText`
  - User schemas: `Person`, `Bot`, `PartialUser`, `User` union
  - All property types with namespace pattern transforms:
    - `Title.asString`, `Title.raw`
    - `RichTextProp.asString`, `RichTextProp.raw`
    - `Number.asNumber`, `NumberRequired`
    - `Checkbox.asBoolean`
    - `Select.asOption`, `SelectRequired`
    - `MultiSelect.asOptions`
    - `Status.asOption`, `StatusRequired`
    - `DateProp.asDate`, `DateRequired`
    - `Url.asString`, `UrlRequired`
    - `Email.asString`, `EmailRequired`
    - `PhoneNumber.asString`, `PhoneNumberRequired`
    - `People.asUsers`
    - `Relation.asIds`
    - `Files.asUrls`
    - `Formula.asValue`
    - `CreatedTime.asDate`, `CreatedBy.asUser`
    - `LastEditedTime.asDate`, `LastEditedBy.asUser`
    - `UniqueId.asString`, `UniqueId.asNumber`
  - Custom `docsPath` annotation linking each schema to official Notion API docs
  - Proper Effect Option handling for nullable fields with `*Required` variants

- **@schickling/notion-effect-client**: Comprehensive test suite with real API integration
  - Unit tests for internal HTTP utilities (29 tests)
    - `parseRateLimitHeaders`, `buildRequest`, `get`, `post` functions
    - `NotionApiError.isRetryable` logic
    - Pagination utilities: `paginationParams`, `toPaginatedResult`, `paginatedStream`
  - Integration tests for all service modules (32 tests)
    - Databases: `retrieve`, `query`, `queryStream` with filters and pagination
    - Pages: `retrieve`, `create`, `update`, `archive`
    - Blocks: `retrieve`, `retrieveChildren`, `retrieveChildrenStream`, `append`, `update`, `delete`
    - Users: `me`, `list`, `listStream`, `retrieve`
    - Search: `search`, `searchStream` with filters and sorting
  - `describe.skipIf` pattern for graceful skipping when no API token
  - Separate `test:unit` and `test:integration` npm scripts
