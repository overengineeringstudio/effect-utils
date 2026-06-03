# @overeng/notion-core

Pure dependency-free Notion primitives and helpers.

## Boundary

`@overeng/notion-core` owns Notion concepts that do not need Effect, HTTP, file
IO, process state, or package-specific runtime services. It is the home for
plain TypeScript primitives, helpers, tuple builders, and classifiers that can
be reused by schema, client, CLI, sync, and rendering packages without pulling
in runtime dependencies.

Milestone 1 uses the Option B split:

- `@overeng/notion-core` owns pure dependency-free Notion primitives, helpers,
  tuple builders, and classifiers.
- `@overeng/notion-effect-schema` owns Effect Schema wire schemas and facades.
- `@overeng/notion-effect-client` owns HTTP API services, pagination, retries,
  rate-limit handling, and API error mapping.

Non-goals for this milestone:

- Do not import Effect from `@overeng/notion-core`.
- Do not move `.nmd` contracts into `@overeng/notion-core`; page-body sync stays
  owned by the NotionMD boundary.
- Do not move canonical codecs yet; existing codec ownership remains staged.
