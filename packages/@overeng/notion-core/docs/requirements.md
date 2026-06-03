# Notion Core Requirements

## Context

These requirements define the shared primitive layer used by the Notion package
family.

## Assumptions

- **A01 Package family:** `@overeng/notion-core`,
  `@overeng/notion-effect-schema`, `@overeng/notion-effect-client`,
  `@overeng/notion-md`, `@overeng/notion-datasource-sync`,
  `@overeng/notion-react`, and `@overeng/notion-cli` share Notion concepts.
- **A02 Dependency boundary:** Shared primitives must be usable without pulling
  in Effect, HTTP, React, CLI, filesystem, SQLite, or Markdown parser runtime
  dependencies.

## Requirements

### Must Stay Dependency-Free

- **R01 Pure runtime:** The package must not depend on Effect, `@effect/*`,
  HTTP clients, filesystem APIs, process state, React, SQLite, or Markdown
  parsers.
- **R02 Stable literals:** Shared Notion literals must be exported as readonly
  tuples with derived TypeScript literal types.

### Must Centralize Shared Notion Primitives

- **R03 API constants:** The package must expose the Notion API version and API
  base URL used by the package family.
- **R04 ID helpers:** The package must expose Notion UUID parse, format,
  compact, and object URL helpers.
- **R05 Property classification:** The package must classify Notion property
  types by write class and fail closed for unknown property types.
- **R06 Raw rich text:** The package must expose plain-text extraction for raw
  Notion rich-text arrays without requiring schema decoding.
