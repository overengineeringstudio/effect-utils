# Notion Effect Client Spec

This document specifies `@overeng/notion-effect-client`. It builds on
[requirements.md](./requirements.md).

## Status

Active.

## Scope

This spec defines:

- Notion HTTP service ownership,
- API constant re-exports,
- relationship to core primitives and schema decoding,
- resource-module boundaries.

It does not define:

- dependency-free Notion primitives, owned by `@overeng/notion-core`,
- Effect Schema wire contracts, owned by `@overeng/notion-effect-schema`,
- `.nmd` file and sidecar contracts, owned by `@overeng/notion-md`,
- datasource sync persistence and reconciliation, owned by
  `@overeng/notion-datasource-sync`,
- root command composition, owned by `@overeng/notion-cli`.

## Layering

Requirement trace: R01-R08.

```
notion-core
  ├── notion-effect-schema
  │     └── wire schemas and canonical codecs
  └── notion-effect-client
        ├── config.ts          # client config, token resolution, API constants
        ├── internal/http.ts   # request execution, retry, telemetry
        ├── internal/pagination.ts
        └── *.ts               # resource services
```

`@overeng/notion-effect-client` re-exports API constants from
`@overeng/notion-core` to preserve the public client import path. Resource
modules consume schema-owned wire contracts and keep HTTP concerns inside the
client package.

## Resource Modules

Requirement trace: R02-R04.

| Module             | Responsibility                                      |
| ------------------ | --------------------------------------------------- |
| `blocks.ts`        | Block retrieve, children, append, update, delete.   |
| `comments.ts`      | Comment operations.                                 |
| `data-sources.ts`  | Data-source retrieve, query, update, and metadata.  |
| `databases.ts`     | Database retrieve and data-source target helpers.   |
| `files.ts`         | File upload primitives.                             |
| `pages.ts`         | Page create, retrieve, update, and archive.         |
| `search.ts`        | Search API.                                         |
| `users.ts`         | User API.                                           |
| `views.ts`         | View API primitives.                                |
