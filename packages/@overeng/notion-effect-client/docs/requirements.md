# Notion Effect Client Requirements

## Context

These requirements define the Effect-native HTTP client layer for the Notion
API. The client consumes shared primitives from
[Notion core requirements](../../notion-core/docs/requirements.md)
and wire schemas from
[Notion Effect Schema requirements](../../notion-effect-schema/docs/requirements.md).

## Assumptions

- **A01 Core constants:** API constants and dependency-free helpers come from
  `@overeng/notion-core`.
- **A02 Schema decoding:** Wire payload validation and schema transforms come
  from `@overeng/notion-effect-schema`.
- **A03 Effect runtime:** The client may depend on Effect and Effect Platform to
  model services, errors, retries, and configured transport.

## Requirements

### Must Own HTTP API Services

- **R01 Request execution:** The package must own Notion HTTP request
  construction and execution.
- **R02 Resource modules:** The package must expose resource services for
  supported Notion API families.
- **R03 Pagination:** Cursor-paginated endpoints must expose reusable
  pagination helpers.
- **R04 Retry and rate limits:** The package must handle retryable Notion API
  failures and rate-limit metadata.

### Must Preserve Public Constants

- **R05 API constants:** The client must preserve public exports for the Notion
  API version and base URL while sourcing shared constant values from core.

### Must Keep Boundaries Clear

- **R06 Schema consumption:** The client must consume schemas rather than
  duplicate wire payload definitions.
- **R07 No local file-format ownership:** The client must not own `.nmd` file
  or sidecar contracts.
- **R08 No root CLI ownership:** The client must not own user-facing root CLI
  command composition.
