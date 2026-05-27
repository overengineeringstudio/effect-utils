# Notion Datasource Sync Capability Gaps

This checklist records the current `@overeng/notion-datasource-sync` capability boundary against the public Notion API, verified against official Notion documentation on 2026-05-26.

It is a release-readiness aid, not a task plan. The sync package should keep unsupported surfaces fail-closed until they have canonical models, deterministic fake-service coverage, and live Notion evidence.

Actionable follow-up work for feasible gaps is tracked in
[GitHub issue #698](https://github.com/overengineeringstudio/effect-utils/issues/698).

## Official Docs Consulted

- [Data source object](https://developers.notion.com/reference/data-source)
- [Retrieve a data source](https://developers.notion.com/reference/retrieve-a-data-source)
- [Update a data source](https://developers.notion.com/reference/update-a-data-source)
- [Update data source properties](https://developers.notion.com/reference/update-data-source-properties)
- [Query a data source](https://developers.notion.com/reference/query-a-data-source)
- [Data source properties](https://developers.notion.com/reference/property-object)
- [Page properties](https://developers.notion.com/reference/property-value-object)
- [Page property items](https://developers.notion.com/reference/property-item-object)
- [Retrieve a page](https://developers.notion.com/reference/retrieve-a-page)
- [Page object](https://developers.notion.com/reference/page)
- [View object](https://developers.notion.com/reference/view)
- [Working with views](https://developers.notion.com/guides/data-apis/working-with-views)
- [List views](https://developers.notion.com/reference/list-views)
- [Create a view](https://developers.notion.com/reference/create-view)
- [Update a view](https://developers.notion.com/reference/update-a-view)
- [File Upload object](https://developers.notion.com/reference/file-upload)
- [Retrieving existing files](https://developers.notion.com/guides/data-apis/retrieving-files)
- [Uploading small files](https://developers.notion.com/guides/data-apis/uploading-small-files)
- [Block object](https://developers.notion.com/reference/block)
- [Append block children](https://developers.notion.com/reference/patch-block-children)
- [Request limits](https://developers.notion.com/reference/request-limits)
- [Connection capabilities](https://developers.notion.com/reference/capabilities)
- [Status codes](https://developers.notion.com/reference/status-codes)

## Current Support

| Surface                         | Status                                                                                                                                                                                                   | Local evidence                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Data-source schema observation  | Supported for canonical hashing of observed `properties`; property config contributes to data-source observation identity.                                                                               | `src/core/commands.ts`, `src/sync/observation.ts`, `src/gateway/notion.ts`          |
| Data-source row query           | Supported for data-source query pagination, canonical filters, sorts, and high-watermark mapping in the conservative subset.                                                                             | `src/gateway/notion.ts`, `src/e2e/live-notion.e2e.test.ts`                          |
| Page retrieval and lifecycle    | Supported for page retrieve plus `in_trash` trash/restore commands guarded by stale-base checks.                                                                                                         | `src/gateway/notion.ts`, `src/e2e/fake-service.e2e.test.ts`                         |
| Page-property pagination        | Supported through `GET /v1/pages/{page_id}/properties/{property_id}` and gateway `listMetadataHash`; required metadata is preserved for paginated property-item lists.                                   | `packages/@overeng/notion-effect-client/src/pages.ts`, `src/gateway/notion.ts`      |
| Writable scalar page properties | Supported for title, rich text, number, checkbox, date, select, multi-select, status value, relation, people, email, URL, and phone number when the canonical value has enough remote shape information. | `src/gateway/notion.ts`                                                             |
| Conservative schema patches     | Supported for add property, rename property, and additive select/multi-select options with explicit existing option snapshots.                                                                           | `src/core/commands.ts`, `src/gateway/notion.ts`, `src/planner/planner.unit.test.ts` |
| NotionMD body boundary          | Supported for body observation, local `.nmd` materialization, guarded local body changes, and body push through the public NotionMD adapter.                                                             | `src/body/notion-md.ts`, `src/e2e/body-adapter.e2e.test.ts`                         |
| Public local SQLite replica     | Product contract is `workspace/notion.sqlite` for user reads/write intents, backed by the internal sync-control store.                                                                                   | `docs/vrs/spec.md`, `docs/getting-started.md`                                       |
| File upload client primitive    | Available in `@overeng/notion-effect-client`; not yet promoted to datasource-sync write semantics.                                                                                                       | `packages/@overeng/notion-effect-client/src/files.ts`                               |
| Raw View API client primitive   | Available in `@overeng/notion-effect-client`; not yet part of datasource-sync authority or demos.                                                                                                        | `packages/@overeng/notion-effect-client/src/views.ts`                               |

## Fail-Closed Or Intentionally Unsupported

| Surface                                 | Current boundary                                                                                                   | Reason                                                                                                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Views as sync surfaces                  | Datasource-sync does not observe, diff, create, update, delete, or query through Notion views.                     | Views have independent filters, sorts, layout config, linked-view placement, and dashboard/widget semantics. Treating them as data-source row membership would blur source-of-truth boundaries. |
| Linked data sources                     | Unsupported.                                                                                                       | Official docs state linked data sources cannot be retrieved directly; the original source database must be shared with the connection.                                                          |
| Files property writes                   | `files` canonical values are observed as hashed identity, but page-property writes fail closed.                    | Existing Notion-hosted file URLs are temporary; safe writes require durable `file_upload` identity, attachment lifecycle tracking, and explicit local file retention rules.                     |
| File download URL identity              | Expiring Notion-hosted URLs are not treated as stable identities.                                                  | Official file docs say Notion-hosted URLs expire and must be refreshed from the API.                                                                                                            |
| Computed page property writes           | Formula, rollup, created/edited audit fields, and unique ID values are read-only or derived and blocked as writes. | Notion documents these as computed/read-only values; datasource-sync must not synthesize writes to them.                                                                                        |
| Status schema updates                   | Unsupported even though status page values can be updated.                                                         | The update-data-source endpoint documents `status` among data-source property types that cannot be updated via API.                                                                             |
| Destructive schema migrations           | Delete property, type conversion, remove/rename options, and replace option lists are fail-closed.                 | Omitted select/multi-select/status options can remove options; deleting/changing columns can reinterpret or hide existing row values.                                                           |
| `place` property values                 | Unsupported/fail-closed.                                                                                           | Official docs say `place` values are not fully supported via API and return `null` for page values.                                                                                             |
| Data-source title/description sync      | Supported as an independent metadata surface.                                                                      | Metadata patches use a separate base metadata hash and do not affect schema or row convergence.                                                                                                 |
| Data-source writable icon sync          | Deferred.                                                                                                          | Icon observation excludes transient signed URLs from stable identity; writable icon commands need additional file/custom/external icon proof.                                                   |
| Page icon/cover/lock metadata           | Not modeled as row surfaces.                                                                                       | Page metadata lives outside data-source property values and needs independent conflict keys and body-adapter surface guards.                                                                    |
| Notion buttons/forms/unsupported blocks | Unsupported inside body sync unless NotionMD proves lossless preservation.                                         | The block API returns unsupported block types for features such as unsupported UI-native blocks; body writes must not delete or reinterpret unknown content.                                    |
| Page body child databases/pages         | Body adapter guards destructive body updates that would delete child pages/databases.                              | Child database/page blocks carry independent identity and cannot be treated as markdown text.                                                                                                   |
| Permission-ambiguous absence            | Fail-closed.                                                                                                       | Notion 403/404 can mean either missing object or missing access; absence cannot prove deletion without direct classification.                                                                   |
| Rate-limit-sensitive wide scans         | Bounded and serial in live tests; not promoted to unbounded production readiness.                                  | Notion documents an average request rate limit and variable future limits.                                                                                                                      |
| Writable generated SQL views            | Explicit write-intent rows are the supported public write model first.                                             | Direct SQL triggers on generated views are possible later, but hidden trigger behavior would make dry-run, audit, and conflict semantics harder to prove.                                       |

## Missing But Feasible Next

| Gap                                               | Why feasible                                                                                                                            | Required proof before support                                                                                                                                                          |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| View inventory/read model                         | Official View APIs list and retrieve full view objects for API version `2025-09-03` and later.                                          | Add canonical view snapshot/hash model, linked-view parent identity, fake-service drift tests, and live view list/retrieve fixtures.                                                   |
| View create/update/delete                         | Official docs expose create, update, and delete endpoints.                                                                              | Keep separate from row membership; require explicit view commands, stale-base checks, and live cleanup because view deletion cannot be undone through the API.                         |
| Query-through-view support                        | Official docs expose view query creation and pagination.                                                                                | Define whether view query results are only a display/read model or can produce membership proofs; block absence classification until query IDs and cached result semantics are proven. |
| Data-source icon, parent, and trash metadata sync | Official update-data-source docs include icon, parent, and trash fields.                                                                | Extend the existing metadata surface beyond title/description only after icon file-upload/external/custom-emoji identity and parent/trash authority are proven.                        |
| Database container metadata                       | Database title, description, icon, cover, parent, inline state, and child data-source list are database-level, not data-source schema.  | Add a database gateway surface only if datasource-sync owns database container convergence; otherwise document it as out of scope.                                                     |
| Durable files property writes                     | Official File Upload API supports upload, attach to files properties, reuse, and retrieval.                                             | Model local file identity, file upload status, expiry, attachment verification, multi-part uploads for large files, redaction, cleanup, and read-after-write checks.                   |
| File blocks in body sync                          | Official file objects can appear in blocks as images, PDFs, audio, video, and files.                                                    | NotionMD must preserve or explicitly map file blocks without losing binary identity; datasource-sync must reject body pushes that drop attached file identity.                         |
| `unique_id` observation                           | Official docs expose unique ID schema and read-only page values.                                                                        | Add canonical `unique_id` value/schema support as read-only computed state, including prefix changes and query/filter behavior if Notion permits it.                                   |
| Verification page property                        | Official docs allow setting verification state on wiki database pages; `verified_by` is read-only.                                      | Add a verification canonical value only for wiki-backed fixtures; write shape must ignore `verified_by` and guard non-wiki failures.                                                   |
| Formula/rollup completeness                       | Official page-property item docs define incomplete rollups and recommend property-item pagination for formula/rollup/relation accuracy. | Add type-specific canonicalization for final rollup metadata, unsupported rollup functions, formula depth errors, and permission-incomplete values.                                    |
| Relation sharing diagnostics                      | Official docs require related databases/data sources to be shared for relation retrieval/update and formula/rollup completeness.        | Add fake and live relation target sharing checks that distinguish inaccessible target from empty relation.                                                                             |
| High-cardinality body pulls                       | Official block pagination and append limits make this feasible with chunked traversal/writes.                                           | Add live body fixtures over 100+ blocks and NotionMD losslessness checks; respect append request limits.                                                                               |
| Multi-source database demos                       | The data-source model supports multiple data sources under one database container.                                                      | Demo should show multiple data sources with different schemas and view configurations while keeping each data source's row/schema authority separate.                                  |
| Rich schema migration workflows                   | Schema drift can be observed and guarded, and safe additive schema patches exist.                                                       | Add impact reports, migration IDs, preview/apply UX, historical fixture migration tests, and live proof before destructive/type-changing schema workflows.                             |
| Writable generated views                          | The local replica can expose ergonomic read views over generic cell data.                                                               | Add `INSTEAD OF` triggers only after explicit intent tables are proven; triggers must enqueue the same guarded intents and never call Notion directly.                                 |

## Not Directly Implementable Via Current Public API

| Surface                                                   | API limitation                                                                                                                                                       |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retrieving linked data-source internals directly          | Official retrieve-data-source docs require access to the original source database; linked data sources themselves are not retrievable as independent schema sources. |
| Stable identity from existing Notion-hosted download URLs | Existing file URLs are temporary signed links; the durable identity must come from file objects or File Upload IDs, not the URL string.                              |
| Status group reconfiguration                              | Official update-data-source-properties docs state status groups cannot be reconfigured through the API.                                                              |
| Direct writes to rollup/formula values                    | These values are computed by Notion; updates must target the source properties, relation targets, or schema.                                                         |
| Direct writes to `unique_id` values                       | Unique IDs are auto-incrementing and read-only.                                                                                                                      |
| Direct `place` page values                                | Official docs say place page values are not fully supported and read as `null`.                                                                                      |
| Lossless support for unsupported block types              | Unsupported block types are surfaced as unsupported objects. Datasource-sync cannot safely render/edit them without NotionMD preserving identity and content.        |
| Moving existing blocks with append API                    | The append endpoint can insert new children but does not move existing blocks.                                                                                       |
| Appending more than 100 block children in one request     | Official request limits require chunked writes.                                                                                                                      |

## Release Checklist

- [ ] Treat view APIs as their own authority surface, not as implicit data-source membership.
- [x] Add a metadata surface for data-source title/description sync.
- [ ] Extend metadata surfaces before syncing data-source icons, parent, trash, or database container attributes.
- [ ] Promote files from hashed observation to writable sync only after durable file-upload identity and attachment lifecycle are modeled.
- [ ] Keep computed/generated values (`formula`, `rollup`, audit fields, `unique_id`) read-only unless Notion documents a write path.
- [ ] Keep `place`, linked data sources, unsupported blocks, and incomplete property pagination fail-closed.
- [ ] Add relation-sharing diagnostics before considering an empty relation, rollup, or formula value authoritative.
- [ ] Keep all live high-cardinality/demo scenarios serial, rate-limited, and cleanup-ledger backed.
