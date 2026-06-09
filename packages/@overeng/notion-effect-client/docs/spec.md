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
- live body observation,
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
        ├── body-observation.ts # live body fidelity observation
        └── *.ts               # resource services
```

`@overeng/notion-effect-client` re-exports API constants from
`@overeng/notion-core` to preserve the public client import path. Resource
modules consume schema-owned wire contracts and keep HTTP concerns inside the
client package.

## Live Body Observation

Requirement trace: R02-R09.

`@overeng/notion-effect-client` owns the live Notion observation needed to turn
core's pure body-fidelity classifier into evidence from the real workspace.

```
GET /pages/{page_id}
        |
        v
BeforePageMetadata

GET /pages/{page_id}/markdown
        |
        v
MarkdownBodySnapshot

retrieve block tree -> render with client Markdown renderer
        |
        v
BlockInventory

GET /pages/{page_id}
        |
        v
AfterPageMetadata

MarkdownBodySnapshot + BlockInventory
        |
        v
core classifyBodyCompleteness
        |
        v
NotionBodyObservation
```

`NotionBodyObservation` is evidence, not policy. It includes endpoint Markdown,
block inventory, independently rendered block-tree Markdown, and core
`BodyCompleteness`. The client package does not decide whether a caller may
adopt the body as a clean base, refresh a local file, or proceed with a write.
`@overeng/notion-md` owns those decisions; `@overeng/notion-datasource-sync`
consumes the resulting evidence through body guards.

The rendered block-tree Markdown is the faithful body candidate for callers
that need clean-base adoption. Endpoint Markdown remains diagnostic evidence:
it reports truncation and unknown block IDs, and it is useful for comparing
Notion's markdown endpoint against the block tree, but callers must not reparse
endpoint Markdown as the canonical pull body when block-level fidelity matters.

Because Markdown and block-tree reads are separate Notion API observations,
the client brackets them with page metadata reads and compares
`last_edited_time`. If the metadata changes across the observation window, the
client retries the full window up to a small fixed bound, then fails closed with
`NotionBodyObservationChangedError`. This makes live body observation
conservative without changing the pure classifier: `last_edited_time` is a
stability signal, not a transactional snapshot token, and callers still own
adoption/write policy.

## Resource Modules

Requirement trace: R02-R04.

| Module                | Responsibility                                      |
| --------------------- | --------------------------------------------------- |
| `blocks.ts`           | Block retrieve, children, append, update, delete.   |
| `comments.ts`         | Comment operations.                                 |
| `data-sources.ts`     | Data-source retrieve, query, update, and metadata.  |
| `databases.ts`        | Database retrieve and data-source target helpers.   |
| `files.ts`            | File upload primitives.                             |
| `pages.ts`            | Page create, retrieve, update, and archive.         |
| `body-observation.ts` | Live Markdown/block-tree body fidelity observation. |
| `search.ts`           | Search API.                                         |
| `users.ts`            | User API.                                           |
| `views.ts`            | View API primitives.                                |
