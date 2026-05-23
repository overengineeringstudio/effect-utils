# Notion Markdown Sync Spec

This document specifies the Notion Markdown sync system. It builds on [requirements.md](./requirements.md).

## Status

Draft -- production architecture defined; implementation and E2E coverage must converge on this spec.

## Scope

This spec defines:

- local `.nmd` files and the v2 local state store,
- sync surfaces and conflict policy,
- Effect service boundaries and layer construction,
- CLI and watch lifecycle,
- OpenTelemetry trace design,
- verification expectations.

This spec does not define a generic Notion renderer, a rich text editor, or a full offline Notion clone.

## Architecture

```
notion-md-cli / notion-md-watch
  |
  v
Effect services
  |-- CliService
  |-- SyncService
  |-- MergeService
  |-- LocalStateStore
  |-- ObjectStore
  |-- NotionGateway
  |-- CommentBridge
  |-- FileSync
  |-- WatchService
  `-- Telemetry
        |
        v
Local workspace                     Notion API
  doc.nmd                             pages/*/markdown
  .notion-md/objects/sha256/...       pages/properties
                                      blocks
                                      comments
                                      data_sources
                                      file_uploads
                                      webhooks
```

Requirement trace: R01-R05, R16-R24.

The system treats Notion enhanced Markdown as one surface among several. The body surface is editable Markdown. Sync metadata and non-body overflow state are represented by strict frontmatter plus content-addressed object refs and projected to the correct Notion API surface.

## Local File And State Store

```
doc.nmd
  frontmatter: strict local sync state and object refs
  body: stock Notion enhanced Markdown

.notion-md/objects/sha256/<digest>
  immutable content-addressed payloads
```

Requirement trace: R06-R10.

### `.nmd` Body Contract

The bytes after frontmatter are stock Notion enhanced Markdown. The body is the only local content sent to `POST /v1/pages` or `PATCH /v1/pages/{page_id}/markdown` as Markdown.

```markdown
---
notion_md:
  version: 1
  page_id: '00000000-0000-4000-8000-000000000001'
  body:
    hash: 'sha256:...'
    base:
      _tag: object_ref
      role: base_snapshot
      hash: 'sha256:...'
      path: '.notion-md/objects/sha256/...json'
      media_type: application/json
      byte_length: 512
    format: 'notion-enhanced-markdown'
  storage:
    _tag: self_contained
---

Enhanced Markdown body.
```

The frontmatter is a local wrapper. Unknown keys are schema errors. The body hash is computed over canonical stripped body bytes.

### Frontmatter Envelope

```ts
type NmdFrontmatterV1 = {
  readonly notion_md: {
    readonly version: 1
    readonly api_version: '2026-03-11'
    readonly object: 'page'
    readonly page_id: NotionId
    readonly parent: ParentRef
    readonly body: BodySurfaceState
    readonly page: PageState
    readonly data_source: DataSourceSurfaceState | null
    readonly properties: Record<string, PropertyValue>
    readonly storage: SelfContainedStorage | ObjectStoreStorage
  }
}
```

Every field is decoded with Effect Schema. The schema uses rich types where available: branded Notion IDs, SHA-256 digests, UTC date-times, non-negative sizes, literal unions, and tagged unions. Unknown frontmatter keys are schema errors.

### Content-Addressed Objects

Object IDs are `sha256:<hex>`. Objects are immutable.

| Object role       | Stored payload                          | Used by                |
| ----------------- | --------------------------------------- | ---------------------- |
| `base_snapshot`   | canonical Markdown base envelope        | body merge             |
| `storage_payload` | overflow unsupported/file/comment units | frontmatter overflow   |
| `file_payload`    | local attachment bytes or metadata      | file upload and export |
| `comment_payload` | Notion comment/discussion data          | comment bridge         |
| `schema_snapshot` | data-source schema                      | property validation    |

Notion signed retrieval URLs may be cached with expiry metadata, but they are not durable identifiers.

## Sync Surfaces

| Surface            | Local state                   | Pull API                   | Push API                          | Default conflict unit |
| ------------------ | ----------------------------- | -------------------------- | --------------------------------- | --------------------- |
| Body               | `.nmd` body + `base_snapshot` | `GET /pages/{id}/markdown` | Markdown update endpoint          | canonical Markdown    |
| Page metadata      | frontmatter                   | `GET /pages/{id}`          | `PATCH /pages/{id}`               | field                 |
| Properties         | frontmatter + schema object   | `GET /pages/{id}`          | `PATCH /pages/{id}`               | property id           |
| Data-source schema | object store                  | `GET /data_sources/{id}`   | schema APIs when supported        | schema hash           |
| Comments           | frontmatter + comment object  | comments API               | comments API                      | discussion/comment id |
| Files              | object store                  | file/block APIs            | file upload + block/property APIs | content hash          |
| Unsupported blocks | object store                  | block API                  | block API or preserve remote      | block id              |
| Review             | local review state            | local only or comments API | explicit bridge only              | review id             |

Requirement trace: R01-R05, R11-R15.

## Pull Flow

1. Decode CLI options with Effect Schema.
2. Read current Notion page metadata.
3. Pull body Markdown.
4. If Markdown reports unknown or truncated blocks, retrieve each block through the block API.
5. Pull data-source schema when the page belongs to a data source.
6. Pull comments and files only when the selected surface set includes them.
7. Canonicalize body Markdown and compute hashes.
8. Write immutable objects first.
9. Write `doc.nmd`.
10. Emit a pull result with changed surfaces and object IDs.

Every pull writes a new clean base for each selected surface.

## Push Flow

1. Decode `.nmd`, object references, and selected CLI options.
2. Re-read current remote metadata and body before any write.
3. Compare remote state to the local clean base per surface.
4. Reject unresolved review markup unless the selected mode handles it.
5. Reject unknown-block, child-page, child-database, file, and synced-block deletion unless an explicit destructive mode names the affected objects.
6. For unchanged remote body base, push canonical body with `replace_content`.
7. For changed remote body base, run the merge policy.
8. Encode property changes through typed property schemas.
9. Upload changed file objects before writing file references.
10. Update local bases only after remote verification succeeds.

Push is surface-aware. A body conflict does not imply a property conflict, and a property conflict does not authorize a body overwrite.

## Merge Policy

Body merge operates on canonical pulled Markdown.

1. If local equals base, accept remote.
2. If remote equals base, accept local.
3. If local and remote changes are non-overlapping, merge.
4. If the merged body would drop protected placeholders or child references, reject.
5. If unresolved, write a local Roughdraft conflict artifact and leave remote unchanged.

`update_content` is an optimization, not the merge engine. It may be used only when every hunk is unique or deliberately `replace_all_matches`, and the returned Markdown verifies every intended change.

## Effect Service Design

```
NotionMdCli
  provides: Command tree, option schemas, JSON/text renderers

SyncService
  depends: NotionGateway, LocalStateStore, MergeService, FileSync, CommentBridge, Telemetry

NotionGateway
  depends: NotionConfig, HttpClient
  owns: typed Notion API calls and response schemas

LocalStateStore
  depends: FileSystem, ObjectStore
  owns: .nmd/frontmatter decode, object refs, atomic writes, reachability

ObjectStore
  depends: FileSystem
  owns: content-addressed object reads/writes and garbage collection

WatchService
  depends: SyncService, LocalStateStore, Clock
  owns: local events, remote polling, coalescing, cancellation
```

Requirement trace: R16-R20.

Implementation rules:

- All untrusted payloads decode with Effect Schema at the boundary.
- Expected errors are `Schema.TaggedError` classes with page/file/surface context.
- Service methods expose typed error unions instead of `unknown`.
- Layers are composed once at the process boundary; service methods do not manually re-provide captured dependencies.
- Long-lived resources use scoped layers or `forkScoped`.

## CLI Shape

```
notion-md pull <page-id-or-url> --out <file.nmd> [--surface body,properties,...]
notion-md status <file.nmd> [--json]
notion-md diff <file.nmd> [--surface body|properties|comments|files]
notion-md push <file.nmd> [--dry-run] [--force-body] [--allow-delete <id>]
notion-md sync <file.nmd> [--watch] [--poll-interval <duration>]
notion-md comments pull|push <file.nmd>
notion-md doctor <page-id-or-url|file.nmd>
notion-md store verify|gc|export <file.nmd>
```

Every command has described arguments/options, JSON output mode, and typed option schemas. Destructive flags identify the surface and object they affect.

## Watch Lifecycle

Watch mode is one scoped Effect program:

```
file events ----\
remote poll ----- > bounded event queue -> debounce/coalesce -> single sync pass
webhook marks ---/
```

Requirement trace: R19-R20, R28.

Rules:

- One sync pass runs per file at a time.
- New events during a pass set a pending reason and schedule exactly one follow-up pass.
- Interruption cancels queued work, timers, watchers, HTTP calls, and in-flight writes.
- State writes are atomic: objects first, state next, `.nmd` last.
- Watch mode emits one root span per sync pass.

## OpenTelemetry Design

Requirement trace: R21-R24, R29.

Service names:

| Process            | `service.name`      |
| ------------------ | ------------------- |
| CLI one-shot       | `notion-md-cli`     |
| local watch daemon | `notion-md-watch`   |
| webhook receiver   | `notion-md-webhook` |

Span names:

| Span                           | Required attributes                                                             |
| ------------------------------ | ------------------------------------------------------------------------------- |
| `notion-md.command`            | `span.label`, `notion-md.command`, `notion-md.file`, `notion-md.page_id`        |
| `notion-md.sync-pass`          | `span.label`, `notion-md.reason`, `notion-md.surfaces`, `notion-md.result`      |
| `notion-md.surface.pull`       | `span.label`, `notion-md.surface`, `notion-md.changed`                          |
| `notion-md.surface.push`       | `span.label`, `notion-md.surface`, `notion-md.changed`, `notion-md.destructive` |
| `notion-md.merge`              | `span.label`, `notion-md.merge.result`                                          |
| `notion-md.object-store.write` | `span.label`, `notion-md.object.kind`, `notion-md.object.hash`                  |
| `NotionHttp.<METHOD>`          | `span.label`, `http.method`, `notion.path_template`, `notion.request_id`        |

`span.label` is short and human-readable: file basename, page id prefix, surface name, or operation result. Attributes never include tokens, full Markdown bodies, file bytes, or signed URLs.

## Verification

| Test layer          | Required coverage                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| Unit                | schemas, canonicalization, hash stability, object refs, merge, destructive guards                  |
| Service integration | fake Notion gateway, fake state store, typed errors, layer composition                             |
| Watch integration   | debounce, coalescing, cancellation, pending events, atomic writes                                  |
| Notion E2E          | supported body feature matrix, guarded push, unknown blocks, child deletion guard, comments, files |
| OTEL                | expected spans and safe attributes for CLI and watch passes                                        |

E2E tests create temporary Notion pages under a configured parent and verify cleanup through `in_trash: true`.

## Design Questions

- **DQ1 Inline equation fidelity:** Determine whether escaped inline equation pull output is a rendering artifact or a loss of equation semantics.
- **DQ2 Page/database reference writes:** Determine the supported write path for page and database references: enhanced Markdown, block API, or preserve-only object payloads.
- **DQ3 Property snapshots:** Decide whether last-clean property snapshots stay inline in frontmatter or move to content-addressed objects.
- **DQ4 Comment anchoring:** Define when Roughdraft anchors are strong enough to project to Notion block/page comments.
- **DQ5 Store index backend:** Choose JSON or SQLite for `.notion-md/index` based on repository size and concurrent watch requirements.
- **DQ6 Webhook deployment:** Decide whether webhook support is a local daemon, hosted service, or optional integration point.
