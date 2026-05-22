# Notion Markdown Local Format Contract

Status: design recommendation for the `.nmd` local format. This document narrows the local file/frontmatter contract, the page-property and data-source strategy, and the webhook role for a Notion <> Markdown sync tool built on Notion enhanced Markdown.

## Recommendation

Use `.nmd` as the durable editing format:

1. The body after frontmatter is stock Notion enhanced Markdown.
2. The YAML frontmatter is local sync metadata and typed page-property state.
3. Compact sync state stays self-contained in frontmatter.
4. Large, volatile, or non-human-friendly sync state escalates to a sidecar manifest.
5. Page body, page properties, data-source schema, comments, files, and webhook notifications stay separate sync surfaces.

Do not invent body syntax for Notion features that stock enhanced Markdown already supports. Local extensions belong either in frontmatter, in sidecars, or in a separate review layer such as Roughdraft.

## Evidence

- Notion's enhanced Markdown docs define the Markdown endpoint format as the body content interchange used by `POST /v1/pages`, `GET /v1/pages/:page_id/markdown`, and `PATCH /v1/pages/:page_id/markdown`; it extends Markdown with XML-like tags and attribute lists.
- Local experiments already showed that YAML frontmatter sent through the Markdown endpoint becomes literal body text. Stripping frontmatter before push produces clean pulled Markdown.
- A light data-source probe under the shared experiment parent page created a disposable database, created one row with typed title/select/multi-select/checkbox/date/url/number properties plus Markdown body content, queried the data source, updated row properties, read row Markdown, and archived the test database. Result: properties are only on the page object; `GET /markdown` returned only body content.
- Current Notion docs say page creation under a data source must provide `parent.data_source_id`, and page properties must match the parent data-source schema.
- Notion webhook docs describe webhooks as event notifications. They include event id, timestamp, type, entity, and event-specific data, but the receiver still calls the API to fetch current state.

## File Shape

An `.nmd` file is a versioned envelope plus Notion enhanced Markdown body:

```markdown
---
notion_md:
  version: 1
  api_version: '2026-03-11'
  object: 'page'
  page_id: '00000000-0000-4000-8000-000000000001'
  url: 'https://www.notion.so/...'
  parent:
    _tag: 'page' # page | data_source | database | workspace | block | unknown
    id: '...'
  body:
    format: 'notion-enhanced-markdown'
    hash: 'sha256:...'
    last_pulled_at: '2026-05-22T14:50:00.000Z'
    remote_last_edited_time: '2026-05-22T14:49:59.000Z'
    truncated: false
    unknown_block_ids: []
  page:
    title: 'Page title'
    icon: null
    cover: null
    in_trash: false
    is_locked: false
  data_source: null
  properties: {}
  storage:
    _tag: 'self_contained'
    unsupported_blocks: []
    files: []
    comments: []
---

Enhanced Markdown body starts here.
```

Rules:

- `notion_md.version` is the local format version, not the Notion API version.
- `api_version` is the Notion API version used for the last clean pull.
- `body.hash` is computed over the canonical stripped body bytes, never over frontmatter.
- `remote_last_edited_time` is advisory conflict evidence; `body.hash` is the stronger body guard.
- `unknown_block_ids` and `truncated` make a pull non-clean until resolved through block API fallback or explicit user policy.
- Unknown keys under `notion_md` are rejected by the strict local schema. Experimental extensions must be added through a versioned tagged union or a new local format version.
- A page whose visible body intentionally starts with YAML frontmatter must escape it or insert content before it. Leading YAML frontmatter is reserved by `.nmd`.

## Stock Enhanced Markdown Boundary

The body is exactly the payload sent to and received from the Markdown content endpoints after local wrapper removal. It may contain Notion enhanced Markdown constructs such as XML-like tags for callouts, toggles, columns, media, mentions, citations, colors, synced blocks, page/database references, and tables.

Local-only constructs must not be silently sent as stock body content:

| Construct                   | Location                                  | Push default                                          |
| --------------------------- | ----------------------------------------- | ----------------------------------------------------- |
| Sync metadata               | Frontmatter                               | Strip                                                 |
| Page/data-source properties | Frontmatter                               | Encode through page/property API                      |
| Compact unsupported blocks  | Frontmatter `storage`                     | Preserve or block push                                |
| Bulky unsupported snapshots | Sidecar                                   | Preserve or block push                                |
| Compact file mapping        | Frontmatter `storage`                     | Resolve before body push                              |
| File bytes / volatile URLs  | Sidecar/cache                             | Resolve before body push                              |
| Comments                    | Frontmatter, sidecar, or Roughdraft layer | Separate comments API                                 |
| Suggestions                 | Roughdraft layer                          | Reject unresolved suggestions unless mode is explicit |

This boundary keeps `.nmd` small: it is Notion enhanced Markdown with a local header, not a fork of Notion enhanced Markdown.

## Frontmatter Schema

The local schema should be implemented as an Effect `Schema.TaggedStruct`/`Schema.Struct` tree and treated as the single source of truth for parsing, validation, and migrations.

Conceptual TypeScript shape:

```ts
type NotionMdFrontmatterV1 = {
  readonly notion_md: {
    readonly version: 1
    readonly api_version: '2026-03-11'
    readonly object: 'page'
    readonly page_id: string
    readonly url?: string
    readonly parent: ParentRef
    readonly body: BodyState
    readonly page: PageState
    readonly data_source: DataSourceBinding | null
    readonly properties: Record<string, PropertyFrontmatterValue>
    readonly storage: Storage
  }
}

type ParentRef =
  | { readonly _tag: 'page'; readonly id: string }
  | { readonly _tag: 'data_source'; readonly id: string; readonly database_id?: string }
  | { readonly _tag: 'database'; readonly id: string }
  | { readonly _tag: 'workspace' }
  | { readonly _tag: 'block'; readonly id: string }
  | { readonly _tag: 'unknown'; readonly raw: unknown }

type BodyState = {
  readonly format: 'notion-enhanced-markdown'
  readonly hash: `sha256:${string}`
  readonly last_pulled_at: string
  readonly remote_last_edited_time: string
  readonly truncated: boolean
  readonly unknown_block_ids: readonly string[]
}

type PageState = {
  readonly title: string
  readonly icon: PageIconValue | null
  readonly cover: PageCoverValue | null
  readonly in_trash: boolean
  readonly is_locked: boolean
}

type DataSourceBinding = {
  readonly database_id: string
  readonly data_source_id: string
  readonly schema_hash: `sha256:${string}`
  readonly title_property: string
  readonly property_ids: Record<string, string>
  readonly read_only_properties: readonly string[]
}

type Storage =
  | {
      readonly _tag: 'self_contained'
      readonly unsupported_blocks: readonly UnsupportedBlockUnit[]
      readonly files: readonly FileUnit[]
      readonly comments: readonly CommentUnit[]
    }
  | {
      readonly _tag: 'sidecar'
      readonly path: string
      readonly unsupported_block_ids: readonly string[]
      readonly file_ids: readonly string[]
      readonly comment_ids: readonly string[]
    }
```

Property frontmatter values should be typed and human-editable:

```yaml
properties:
  Name:
    _tag: title
    value: 'Probe Row'
  Status:
    _tag: select
    value: 'Ready'
  Tags:
    _tag: multi_select
    value: ['alpha', 'beta']
  Done:
    _tag: checkbox
    value: true
  Due:
    _tag: date
    value:
      start: '2026-05-22'
      end: null
      time_zone: null
  URL:
    _tag: url
    value: 'https://developers.notion.com/'
  Score:
    _tag: number
    value: 8
```

Writable simple forms:

| Notion property type | Local `value`                         | Write encoding                       |
| -------------------- | ------------------------------------- | ------------------------------------ |
| `title`              | string                                | rich text title from string          |
| `rich_text`          | string or null                        | rich text from string                |
| `number`             | number or null                        | number                               |
| `select`             | option name or null                   | select by name                       |
| `multi_select`       | option names                          | multi-select by names                |
| `status`             | option name or null                   | status by name                       |
| `date`               | `{ start, end?, time_zone? }` or null | date object                          |
| `people`             | user ids                              | people ids                           |
| `files`              | sidecar file refs                     | file objects after upload resolution |
| `checkbox`           | boolean                               | checkbox                             |
| `url`                | string or null                        | url                                  |
| `email`              | string or null                        | email                                |
| `phone_number`       | string or null                        | phone number                         |
| `relation`           | page ids                              | relation ids                         |

Read-only or Notion-generated properties stay visible but non-writable: `formula`, `rollup`, `created_time`, `created_by`, `last_edited_time`, `last_edited_by`, `unique_id`, `verification`, and `button`.

The frontmatter should store property names for readability and property ids for stability. If a property is renamed remotely, the id wins and the next pull rewrites the display name.

## Self-Contained Frontmatter Policy

Self-contained `.nmd` is the preferred default when the extra state is compact and stable. The current Effect schema models this with a `storage` tagged union:

- `_tag: "self_contained"` keeps unsupported block summaries, file lifecycle units, and comment bridge units directly in frontmatter.
- `_tag: "sidecar"` keeps only relative pointers and stable ids in frontmatter.

The first implementation includes `classifyNmdFrontmatterPayload`, which measures the serialized `notion_md.storage` payload:

| Classification | Default size    | Policy                                |
| -------------- | --------------- | ------------------------------------- |
| `small`        | up to 8 KiB     | Keep self-contained.                  |
| `large`        | 8 KiB to 64 KiB | Allow with warning or project policy. |
| `too_large`    | above 64 KiB    | Require sidecar escalation.           |

Self-contained frontmatter is invalid when it embeds raw file bytes, expiring Notion file URLs as durable state, or unsanitized full API snapshots that include volatile/private retrieval data. Those belong in a sidecar or content-addressed cache.

Local experiment outcome: a compact typed frontmatter fixture with two unsupported blocks and two upload units stayed readable at roughly 1.8 KiB. A naive dump of raw block/page snapshots for a tiny page grew to roughly 9.7 KiB and included volatile signed file URLs. Tiny embedded bytes looked harmless only because the test file was 70 bytes; real attachments would make the document noisy and hard to review.

## Sidecar Option

Keep frontmatter small enough to review in diffs. Escalate to `doc.nmd.meta.json` for bulky state:

- raw unsupported block snapshots keyed by block id,
- file upload lifecycle mappings,
- comments and Roughdraft bridge metadata,
- per-block anchors and remote block ids,
- last clean remote base for three-way merge,
- complete data-source schema snapshots when generated TypeScript is not present.

Recommended sidecar shape:

```json
{
  "version": 1,
  "page_id": "...",
  "body_base": {
    "hash": "sha256:...",
    "markdown": "..."
  },
  "unsupported_blocks": {},
  "files": {},
  "comments": {},
  "data_source_schema": null
}
```

The sidecar is local source-of-truth only for sync bookkeeping. Notion remains the source of truth for remote page/body/property state.

## Plain `.md` Plus Sidecar

Plain `.md` mode is viable, but it should be explicitly lower-fidelity:

| Option                     | Pros                                                                     | Cons                                                                       |
| -------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `.nmd` with frontmatter    | Single editable file, self-describing, good conflict checks              | Leading YAML is reserved; local wrapper can confuse generic Markdown tools |
| `.md` plus sidecar         | Body is plain stock enhanced Markdown; no local wrapper sent by accident | File can be separated from metadata; harder to review and move safely      |
| `.md` with hidden comments | Fewer files                                                              | Easy to corrupt body semantics; not stock Notion enhanced Markdown         |

Recommended policy:

- Use `.nmd` for synced pages and rows.
- Offer `--plain-md` export/import for one-shot body movement.
- Offer `.md + .notion.json` only when a user explicitly wants editor/tool compatibility over self-contained sync metadata.

## Data-Source And Property Strategy

Treat a data-source row as two coupled surfaces:

1. The row page body is Markdown content.
2. The row page properties are typed values governed by the parent data-source schema.

Pull:

- Retrieve the page object for page metadata and properties.
- If the parent is a data source, retrieve the data source schema.
- Decode page properties through the schema.
- Retrieve body Markdown separately.
- Write frontmatter properties plus stripped body.

Push:

- Parse and validate frontmatter.
- Retrieve current page metadata, body Markdown, and parent data-source schema.
- Reject or require confirmation if the schema hash changed and property edits are present.
- Encode property changes through `PATCH /v1/pages/{page_id}`.
- Encode body changes through Markdown update/replace semantics.
- Never send frontmatter as Markdown body.

Create:

- For a normal child page, only `title` is a page property; all other metadata must stay local or be represented in body content.
- For a data-source row, create with `parent: { type: "data_source_id", data_source_id }`, typed `properties`, and optional `markdown`.
- Do not rely on a leading body `# Heading` as row title when properties are also provided. The title property is the title source of truth.

Query:

- Query rows through `POST /v1/data_sources/{data_source_id}/query`.
- Use `filter_properties` for large schemas or performance-sensitive status refreshes.
- For large sources, sync incrementally by `last_edited_time` and still verify local body hashes before pushing.

## Reusing `@overeng/notion-cli`

The existing `@overeng/notion-cli` schema generation is the right foundation for property typing:

- It already introspects databases by resolving the first data source and reading properties from `NotionDataSources.retrieve`.
- It generates read schemas, optional write schemas, typed select/status/multi-select literals, property metadata annotations, encode/decode helpers, and an optional API wrapper.
- It already excludes Notion-generated/read-only property types from write schemas.

Recommended reuse:

- Move the `.nmd` property frontmatter schema to depend on the same property metadata and write-transform table used by `@overeng/notion-cli`.
- Generate a `PageProperties` read schema and `PageWrite` write schema for each synced data source.
- Use generated write encoders to turn frontmatter property values into Notion `properties` request payloads.
- Store the generated schema hash in frontmatter to detect drift before applying local property edits.
- Extend the generated API wrapper to create rows under `data_source_id` after resolving the query target. The current generated wrapper still creates with `parent.database_id`, which is accepted by older flows but is not the best long-term shape for the current data-source API.

Avoid a second hand-written property encoder in `notion-md`. If the local format needs a different human-editable shape, implement it as a small decode/encode layer before the generated Notion write schema.

## Webhook Role

Webhooks should make sync more responsive, not less guarded.

Use them for:

- invalidating local status caches,
- scheduling pull/status refreshes,
- detecting page body changes via `page.content_updated`,
- detecting property changes via `page.properties_updated`,
- detecting row adds/removes via `data_source.content_updated`,
- detecting schema drift via `data_source.schema_updated`,
- importing comment activity when comment capabilities are enabled.

Do not use them for:

- conflict resolution,
- replacing body hashes,
- assuming operation order,
- reconstructing a full edit history,
- deciding that missing content was deleted,
- bypassing a fresh pre-push read.

Webhook delivery has practical constraints:

- Subscriptions are configured in the connection UI and require a public HTTPS endpoint.
- Verification is manual and produces a token used for `X-Notion-Signature` HMAC validation.
- Aggregated events can be delayed; docs describe page content updates as batched and not immediate.
- Delivery is retried on failure, but it is still a notification channel. A sync tool must be idempotent and tolerate missed or duplicate refresh work.
- Event payloads identify the entity and changed surface but do not contain the full Markdown body or complete property values.

Long-term design: keep a webhook consumer as an optional daemon that writes "remote dirty" markers into the local sync index. The CLI remains correct without webhooks by polling current state before push.

## Conflict Policy

Default push remains guarded:

1. Parse `.nmd` and canonicalize the stripped body.
2. Retrieve current page metadata and Markdown.
3. If `remote_last_edited_time` and body hash match the last clean pull, push body and property changes.
4. If the body changed remotely, run a three-way merge or targeted `update_content`.
5. If properties changed remotely, diff typed property values against the last clean property snapshot.
6. If the data-source schema changed, require schema regeneration or explicit acceptance before writing properties.

A body conflict must not block independent property updates unless the user asked for an all-or-nothing push. A property conflict must not force a body overwrite. Keep surfaces independent and compose the final status report.

## Open Design Decisions

- Whether `.nmd` frontmatter should include a compact last-clean property snapshot or keep snapshots only in the sidecar.
- Whether comments should be stored in the main sidecar or in a separate review file.
- Whether the default row create command should require a generated schema, or allow ad hoc property maps with stricter runtime validation.
- Whether generated API wrappers should be changed globally from `database_id` creation to resolved `data_source_id` creation.

## Sources

- Notion enhanced Markdown format: https://developers.notion.com/guides/data-apis/enhanced-markdown
- Notion create page API: https://developers.notion.com/reference/post-page
- Notion update page API: https://developers.notion.com/reference/patch-page
- Notion retrieve/query data source APIs: https://developers.notion.com/reference/retrieve-a-data-source and https://developers.notion.com/reference/query-a-data-source
- Notion webhooks and delivery: https://developers.notion.com/reference/webhooks and https://developers.notion.com/reference/webhooks-events-delivery
- Local code reviewed: `packages/@overeng/notion-cli/src/introspect.ts`, `packages/@overeng/notion-cli/src/codegen.ts`, and `packages/@overeng/notion-effect-schema/README.md`
