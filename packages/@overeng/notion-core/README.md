# @overeng/notion-core

Pure dependency-free Notion primitives and helpers.

## Boundary

`@overeng/notion-core` owns Notion concepts that do not need Effect, HTTP, file
IO, process state, or package-specific runtime services. It provides plain
TypeScript primitives, helpers, tuple builders, and classifiers that can be
reused by schema, client, CLI, sync, and rendering packages without pulling in
runtime dependencies.

Package ownership is deliberately narrow:

- `@overeng/notion-core` owns pure dependency-free Notion primitives, helpers,
  tuple builders, and classifiers.
- `@overeng/notion-effect-schema` owns Effect Schema wire schemas, decoders,
  encoders, transforms, and schema facades.
- `@overeng/notion-effect-client` owns HTTP API services, pagination, retries,
  rate-limit handling, and API error mapping.
- `.nmd` file and sidecar contracts belong to the NotionMD boundary, not core.
- Canonical property codecs remain with the schema package because they depend
  on Effect Schema and byte-stable sync encoding.
