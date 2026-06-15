# Notion Markdown Sync Spec

This document specifies the Notion Markdown sync system. It builds on [requirements.md](./requirements.md).

## Status

Draft -- the implemented `@overeng/notion-md` package covers the core body/property sync path, strict `.nmd` frontmatter, content-addressed local state, guarded push/sync/watch behavior, batch multi-file and recursive folder orchestration, Effect Platform file watching, and live Notion E2E coverage. File bytes, comment projection, and webhook delivery are designed surfaces that remain outside the implemented core. Full data-source sync is owned by the standalone [Notion datasource sync spec](../../../notion-datasource-sync/docs/vrs/spec.md).

## Scope

This spec defines:

- the `.nmd` local file contract,
- the `.notion-md` content-addressed local state store,
- sync surfaces and guarded conflict policy,
- CLI, batch, and watch behavior,
- Effect service boundaries,
- OpenTelemetry conventions,
- verification expectations and known limitations.

This spec does not define:

- a generic Notion renderer,
- a rich text editor,
- a full offline Notion clone,
- a replacement syntax for Notion enhanced Markdown.

## System Shape

```
notion-md CLI
  |
  |  pull/status/push/sync/watch/batch
  v
Batch/tree orchestrator
  |
  |-- target discovery, duplicate page-id preflight, bounded concurrency
  v
Sync coordinator
  |
  |-- Local .nmd file
  |-- .notion-md/objects/sha256/<hash>.json
  |-- Notion Markdown endpoint
  |-- Notion page/property APIs
  |-- Notion block API for unsupported blocks
  |-- Future: comments, files, data-source schema, webhooks
```

Requirement trace: R01-R05, R16-R24.

The system treats Notion enhanced Markdown as one sync surface, not the whole page. The body surface is stock Notion enhanced Markdown. Local metadata, page properties, unsupported block preservation, files, comments, and review state are modeled outside the body so they are never silently sent as Notion Markdown.

The public body facade exposes body-only observe, local read, materialize,
verified remote replace, and clean-base settlement operations for adapters that
compose with `.nmd` files. The facade depends on `NotionMdGateway` and
`NmdStateStore`; it does not expose sync coordinator decisions or page metadata
mutation as an adapter surface.

Remote body observations carry `@overeng/notion-core` body-completeness
evidence produced by `@overeng/notion-effect-client` live observation.
`notion-md` is the package that turns that evidence into clean-base policy:
single-page establishment, tree materialization, clean-base refresh, and the
body facade must refuse to treat a lossy Markdown observation as a clean `.nmd`
base.

Batch and folder support do not change the ownership unit: one `.nmd` file maps
to one Notion page, and every mutation still passes through the same page-local
guards. The batch layer only owns target discovery, duplicate page-id preflight,
bounded concurrency, per-file result reporting, and multi-file watch scheduling.

## Local Format

```
doc.nmd
  frontmatter: strict local sync envelope
  body: stock Notion enhanced Markdown

.notion-md/
  objects/sha256/<2>/<62>.json
  sync/<page-id>.json
```

Requirement trace: R06-R10.

### `.nmd` Envelope

The `.nmd` file is a versioned local wrapper around a Notion enhanced Markdown body.
Version 2 keeps human-editable state in the file and moves derived sync
bookkeeping into a page-id keyed sidecar:

```markdown
---
{
  'notion_md':
    {
      'version': 2,
      'api_version': '2026-03-11',
      'object': 'page',
      'page_id': '00000000-0000-4000-8000-000000000001',
      'parent': { '_tag': 'page', 'id': '00000000-0000-4000-8000-000000000000' },
      'page':
        {
          'title': 'Page title',
          'icon': null,
          'cover': null,
          'in_trash': false,
          'is_locked': false,
        },
      'properties': {},
    },
}
---

Enhanced Markdown body starts here.
```

Rules:

| Rule                | Specification                                                                          |
| ------------------- | -------------------------------------------------------------------------------------- |
| Body boundary       | Only bytes after frontmatter are sent to Notion Markdown endpoints.                    |
| Strict schema       | Unknown frontmatter keys are errors.                                                   |
| Body hash           | Hash canonical stripped body bytes, never frontmatter.                                 |
| API version         | `api_version` records the Notion API version used for the last clean pull.             |
| Local version       | `notion_md.version` is the local human-editable envelope version.                      |
| Sync sidecar        | Derived state lives in `.notion-md/sync/{page_id}.json`, keyed by immutable page id.   |
| Visible frontmatter | A page whose visible body starts with `---` must escape or precede that text.          |
| Review markup       | Roughdraft markers are local review state unless an explicit push mode says otherwise. |

Local experiments confirmed that frontmatter sent through the Markdown endpoint becomes literal body content. Push must strip it.

### Frontmatter Schema

The Effect Schema in `@overeng/notion-effect-client` is the source of truth. The
current local shape is split between human-editable V2 frontmatter and
machine-managed V1 sync state:

```ts
type NmdFrontmatterV2 = {
  readonly notion_md: {
    readonly version: 2
    readonly api_version: '2026-03-11'
    readonly object: 'page'
    readonly page_id: NotionId
    readonly url?: string
    readonly parent: ParentRef
    readonly page: PageState
    readonly properties: Record<string, WritablePropertyValue>
  }
}

type NmdSyncStateV1 = {
  readonly version: 1
  readonly page_id: NotionId
  readonly body: BodyState
  readonly storage: SelfContainedStorage | ObjectStoreStorage
  readonly read_only_properties: Record<string, ReadOnlyPropertyValue>
  readonly data_source: DataSourceBinding | null
}
```

Schemas use tagged unions for polymorphic values, branded strings for Notion IDs and hashes, and exact decoding with excess-property rejection.

### Writable Property Values

Property frontmatter is human-editable only for modeled writable forms. Unknown or generated properties remain visible as read-only values.

| Notion property type | Local form                 | Push encoding                 |
| -------------------- | -------------------------- | ----------------------------- |
| `title`              | string                     | rich-text title from string   |
| `rich_text`          | string or null             | rich text from string         |
| `number`             | number or null             | number                        |
| `select`             | option name or null        | select by name                |
| `multi_select`       | option names               | multi-select by names         |
| `status`             | option name or null        | status by name                |
| `date`               | Notion date object or null | date object                   |
| `people`             | user IDs                   | people IDs                    |
| `checkbox`           | boolean                    | checkbox                      |
| `url`                | string or null             | url                           |
| `email`              | string or null             | email                         |
| `phone_number`       | string or null             | phone number                  |
| `relation`           | page IDs                   | relation IDs                  |
| `files`              | file refs                  | future file-upload resolution |
| `place`              | place object or null       | place object                  |
| `verification`       | verification state object  | verification object           |
| generated properties | read-only wrapper          | not pushed                    |

Property IDs must be preserved when available. Display names are for readability; IDs win on rename or schema drift.

### Writable Page Metadata

The page metadata surface covers page state that is not part of the Markdown
body and is not a data-source property.

| Field       | Local form                              | Push encoding       |
| ----------- | --------------------------------------- | ------------------- |
| `title`     | string                                  | page title property |
| `icon`      | null, emoji, native icon, external file | page `icon`         |
| `cover`     | null, external or Notion-hosted file    | external/null cover |
| `in_trash`  | boolean                                 | page `in_trash`     |
| `is_locked` | boolean                                 | page `is_locked`    |

Strict frontmatter accepts the read shapes Notion can return. The write planner
only emits page metadata patches for shapes Notion's page update API accepts:
page titles, null/external covers, null/emoji/native/external icons,
`in_trash`, and `is_locked`. Notion-hosted file URLs and custom emojis are
preserved as pulled state until their write behavior is verified.

## Object Store

Requirement trace: R07-R10, R16.

Objects are immutable JSON payloads addressed by exact stored bytes:

```
.notion-md/objects/sha256/ab/cdef....json
```

| Role              | Payload                         | Required validation                                     |
| ----------------- | ------------------------------- | ------------------------------------------------------- |
| `base_snapshot`   | last clean body snapshot        | page id, body hash, object hash, schema version         |
| `storage_payload` | overflow storage payload        | page id, inventory equality with frontmatter, hash      |
| `file_payload`    | future file bytes or metadata   | content hash, media type, local path or upload identity |
| `comment_payload` | future comment bridge state     | comment IDs, discussion IDs, anchor metadata            |
| `schema_snapshot` | future data-source schema state | schema hash, property IDs, data-source id               |

Write order is object first, `.nmd` last. A failed `.nmd` write may leave orphan objects; a future `store gc` removes unreachable objects. Object paths in frontmatter are logical POSIX-style paths; the state store normalizes both expected and stored paths through the platform `Path` service before reading.

Storage policy:

| Case                                        | Storage form                             |
| ------------------------------------------- | ---------------------------------------- |
| Small stable unsupported/file/comment units | inline `storage._tag = "self_contained"` |
| Large storage payload                       | `storage._tag = "object_store"`          |
| Volatile signed Notion URLs                 | `object_store`                           |
| File bytes                                  | future content-addressed file payload    |
| Raw unsanitized API snapshots               | object store only                        |

The implementation currently supports self-contained storage and content-addressed `storage_payload` objects. It rejects legacy sidecar-shaped frontmatter instead of migrating it.

## Sync Surfaces

Requirement trace: R01-R05, R11-R15.

| Surface                                  | Local state                    | Pull API                              | Push API                                                 | Conflict unit      | Current status              |
| ---------------------------------------- | ------------------------------ | ------------------------------------- | -------------------------------------------------------- | ------------------ | --------------------------- |
| Body                                     | `.nmd` body + `base_snapshot`  | block-tree render + endpoint evidence | Markdown update endpoint                                 | canonical Markdown | implemented                 |
| Page metadata                            | frontmatter page fields        | `GET /pages/{id}`                     | `PATCH /pages/{id}`                                      | field              | title/lock/trash/icon/cover |
| Properties                               | frontmatter property map       | `GET /pages/{id}`                     | `PATCH /pages/{id}`                                      | property           | modeled writable forms      |
| Unsupported / not-round-trip-safe blocks | frontmatter/object storage     | Markdown + block API                  | refuse at pull (R38); round-trip-safe captures preserved | block id           | R38 broadens the lossy gate |
| Data-source schema                       | external datasource-sync state | datasource-sync package               | datasource-sync package                                  | schema hash        | owned by datasource sync    |
| Comments                                 | future comment payload         | comments API                          | comments API                                             | discussion/comment | designed, not implemented   |
| Files                                    | future file payload            | block/file APIs                       | file upload APIs                                         | content hash       | modeled, not implemented    |
| Review                                   | Roughdraft local markup        | local only or comments API            | explicit bridge only                                     | review id          | guard implemented           |

Body conflicts do not block property-only pushes. Property-only pushes across a concurrent remote body edit patch properties, then refresh the local `.nmd` body and base from the current remote state.

## Pull Flow

1. Decode CLI options.
2. Retrieve Notion page metadata.
3. Observe the remote body through the Notion body observation service.
4. Reject clean-base adoption if the observation is lossy. **Under R38 "lossy"
   means any block whose body-Markdown rendering does not reparse to the same
   block** (round-trip-safety), so a page with a `child_database` /
   `table_of_contents` / `synced_block` / `child_page`-in-body / API `unsupported`
   block is refused here — uniformly with the editor verbs (decisions 0016, 0017).
5. Adopt the block-tree-rendered Markdown as the local body and base snapshot;
   keep endpoint Markdown only as diagnostic evidence.
6. Retrieve block-API payloads only for **round-trip-safe** captures (files, media,
   resolvable unknowns) to enrich storage; a not-round-trip-safe block makes the
   observation lossy (step 4) rather than something to preserve and edit around.
7. Compute the body hash over the adopted rendered body.
8. Build a strict frontmatter envelope.
9. Write base snapshot and storage objects.
10. Write the `.nmd` file.
11. Emit a pull result with storage mode and object refs.

Future selected surfaces add data-source schema, comments, and files before the write commit.

## Status Flow

1. Read and decode `.nmd` once.
2. Validate all referenced objects.
3. Retrieve the current remote page and Markdown.
4. Compute local body hash, remote body hash, property edit state, metadata drift, and unresolved unknown block IDs.
5. Return a typed status result.

Status distinguishes `remoteBodyChanged` from `remotePageMetadataChanged`. The current implementation still exposes a combined `remoteChanged` convenience field.

## Push Flow

1. Read and decode `.nmd` once.
2. Pull remote state once for status.
3. Reject clean-base use of any lossy remote body observation.
4. Reject unresolved Roughdraft review markup unless explicitly allowed.
5. Reject body pushes that could delete resolvable unknown blocks unless destructive intent is explicit. (Not-round-trip-safe blocks never reach a push: the page was refused at pull, step 4 / R38 — this push guard is the secondary defense for resolvable captures only.)
6. If only page metadata or properties changed and the remote body changed, patch those surfaces and refresh local body from remote only when the refreshed body is complete.
7. If the remote body changed and local body changed, attempt a conservative three-way merge.
8. If merge succeeds, update Markdown and then properties. Before a property write, compare the data-source schema against the pull-time `schema_snapshot`; on drift, refuse with exit 6 (`NmdSchemaDriftError`, R14) rather than risk silently auto-creating options — resolve by re-pulling.
9. If merge fails, write a Roughdraft conflict artifact and leave remote unchanged.
10. If remote body is still at base, use a targeted Markdown update when safe or guarded replace when necessary.
11. Re-observe the remote body after writes and rewrite `.nmd` with fresh body, base, page metadata, storage, and completeness evidence.

The local file is read once for a push decision to avoid local snapshot drift. Remote body is re-read immediately before guarded Markdown updates to catch races between status and write.

Clean-base writes are allowed only from complete body observations with
block-tree-rendered Markdown available. Endpoint truncation, unknown block IDs,
unsupported inventory entries, missing rendered evidence, or a rendered
block-tree suffix not present in the endpoint Markdown all block establishment,
tree materialization, facade settlement, and post-write clean-base refresh. A
successful remote write is not considered settled until the refreshed
observation is complete; otherwise the local `.nmd` base remains untrusted and
the caller receives a typed lossy-remote-body error.

Pull adoption is block-aware. Notion's Markdown endpoint may omit blank block
boundaries around heading/paragraph/divider sequences; reparsing that endpoint
Markdown through CommonMark can promote prose paragraphs to Setext/ATX headings.
`notion-md` therefore treats endpoint Markdown as evidence and adopts the
client block-tree renderer output as the clean body.

## Merge And Conflict Policy

Requirement trace: R11-R15.

Body merge operates on canonical Markdown:

| Case                          | Result                                    |
| ----------------------------- | ----------------------------------------- |
| local equals remote           | clean                                     |
| local equals base             | accept remote                             |
| remote equals base            | accept local                              |
| non-overlapping ranges        | merge                                     |
| same-range same edit          | accept merged edit                        |
| overlapping different edit    | conflict                                  |
| protected placeholder removal | conflict unless explicit destructive mode |

`update_content` is an optimization. It may be used only when the base hunk is unique in the current remote body and the returned Markdown equals the expected body. Ambiguous or deletion-heavy edits fall back to guarded `replace_content`.

Unresolved conflicts are written beside the `.nmd` file as Roughdraft Markdown:

```markdown
# notion-md body conflict

{==Body conflict==}{>>Remote and local body content both changed since the last clean pull.<<}{id="body-conflict"}

## Base body

...

## Local body

...

## Remote body

...
```

Normal push refuses unresolved Roughdraft review markup. Explicit modes may later apply, render, strip, or bridge review annotations.

## Feature Mapping

Requirement trace: R01-R05.

| Notion feature                        | Local body representation        | Non-body state                  | Fidelity / policy                                          |
| ------------------------------------- | -------------------------------- | ------------------------------- | ---------------------------------------------------------- |
| Page title/icon/cover                 | not body                         | frontmatter page fields         | title preserved; icon/cover modeled                        |
| Page lock/trash state                 | not body                         | frontmatter page fields         | field-level page API patch                                 |
| Paragraphs, headings, lists           | stock Markdown/enhanced Markdown | none                            | supported with Notion normalization                        |
| To-dos, quotes, dividers              | stock Markdown/enhanced Markdown | none                            | supported                                                  |
| Code blocks                           | fenced blocks                    | language normalization          | supported; aliases may normalize                           |
| Equations                             | Markdown/enhanced math syntax    | raw rich-text fallback if lossy | block supported; inline conservative                       |
| Callouts, toggles, tables             | enhanced Markdown tags           | color/attribute normalization   | supported with normalization caveats                       |
| Columns                               | enhanced column tags             | none                            | supported by endpoint, needs coverage                      |
| Images/files/media                    | Markdown/enhanced media tags     | future file payloads            | not fully implemented                                      |
| Bookmark/embed/link preview           | not round-trip-safe in the body  | —                               | **refused at pull** (R38) — edit in Notion                 |
| Child page/database **block in body** | not round-trip-safe in the body  | —                               | **refused at pull** (R30/R38)                              |
| Child page **as a tree node**         | own `.nmd` file (tree)           | tree membership                 | preserved by the file-based tree engine (not a body block) |
| Data-source row properties            | not body                         | typed property map              | modeled writable properties                                |
| Data-source schema/views              | not body                         | future schema snapshot          | not implemented                                            |
| Comments                              | not body                         | future comment bridge           | not implemented                                            |
| Suggestions/review                    | Roughdraft local layer           | review state                    | reject unresolved by default                               |

Known Notion enhanced Markdown limitations:

- Notion normalizes valid Markdown on pull.
- Page title and properties are not included in Markdown body output.
- Some blocks pull as `<unknown>` with `unknown_block_ids`.
- The Markdown endpoint can return a prefix of the rendered block tree, such as
  content before a divider; that response is lossy and cannot become a clean
  `.nmd` base.
- The Markdown endpoint can omit separators around block boundaries; the clean
  pull body is rendered from the block tree so paragraphs adjacent to headings
  and dividers keep their block type.
- Signed file URLs expire and are not durable identity.
- Comments support inline Markdown-like content but are separate from body Markdown.
- A block whose body-Markdown rendering does not reparse to the same block
  (`[TOC]`, `[embedded db]()`, degraded bookmark, …) is **refused at pull** (R38),
  because a push would silently re-create it as a paragraph (experiments.md).
- `allow_deleting_content` can delete resolvable unknown blocks and tree child
  pages/databases; the default is non-destructive. It is not an escape hatch for
  not-round-trip-safe body blocks, which are refused before any push.

Evidence for these limitations lives in [experiments.md](./experiments.md).

## Effect Services

Requirement trace: R16-R20.

```
CLI program
  provides command tree, option schemas, output renderers

Sync coordinator
  depends on NotionGateway and NmdStateStore
  owns pull/status/push/sync decisions

NotionGateway
  depends on NotionConfig and HttpClient
  owns typed Notion API calls and response adaptation

NmdStateStore
  depends on FileSystem and Path
  owns .nmd IO, object refs, object validation, atomic local writes

Merge planner
  pure module for body merge and Markdown update planning

Watch service
  owns event queue, debounce, polling, scoped cancellation
```

Implementation rules:

- Decode untrusted payloads with Effect Schema at the boundary.
- Expected failures use tagged errors with page/file/surface context.
- State-store object reads verify hash, role, schema version, page id, and inventory.
- Layers are composed at process boundaries.
- Long-lived watch resources are scoped and interruptible.
- Pure planning logic stays outside Effect services and has focused unit tests.

## CLI

Current commands:

```bash
notion-md sync <page-id-or-url> page.nmd
notion-md sync docs --from-remote --root <page-id-or-url>
notion-md plan docs
notion-md status page.nmd
notion-md sync page.nmd [--watch] [--poll-interval-ms 30000]
notion-md sync docs
```

Environment:

| Variable           | Meaning          |
| ------------------ | ---------------- |
| `NOTION_API_TOKEN` | Notion API token |

Output:

- One-shot commands emit pretty JSON results by default.
- Watch emits compact NDJSON event lines by default.
- Watch `sync_error` events include structured typed error fields.
- The long-term stable contract is explicit `--output human|json|ndjson`, with `auto` allowed only as a convenience alias after envelope schemas are versioned.

Future CLI contract:

```bash
notion-md diff <file.nmd> [--surface body|properties|comments|files]
notion-md comments pull|push <file.nmd>
notion-md doctor <page-id-or-url|file.nmd>
notion-md store verify|gc|export <file.nmd>
```

Batch commands:

```bash
notion-md status <target...> [--recursive] [--concurrency 4]
notion-md sync <target> [--recursive] [--concurrency 4] [--watch]
```

Rules:

- A single file target emits a single-page JSON result.
- Multiple status targets or flat recursive directory targets emit a batch envelope.
- Directory tree targets read `.notion-md/workspace.json` as an internal tree
  index when present. `plan` reports tree operations without writing files, and
  `sync` applies the local tree unless `--from-remote` is explicit.
- Recursive discovery includes existing `*.nmd` files and skips `.notion-md`,
  `.git`, and `node_modules`.
- Duplicate `page_id` values in the same batch are rejected before any Notion
  mutation.
- Missing or malformed files are reported as per-file errors when other valid
  targets can still run.
- Local file deletion, local rename, and remote page moves are not destructive
  intent. Remote archive/delete remains explicit future behavior.

## Watch Lifecycle

Requirement trace: R19-R20, R28.

```
initial event ----\
file event --------> sliding queue -> debounce -> sync pass -> JSON event
remote poll ------/
```

Rules:

- One sync pass runs at a time per process.
- File events and poll events are coalesced.
- Each pass emits `sync` or `sync_error`.
- Sync-pass spans observe failures before the watch loop recovers.
- Interruption closes the watcher, stops polling, and cancels queued work.
- File events come from the Effect Platform `FileSystem.watch` stream. Production
  adapters are thin stream producers; coalescing policy stays in the watch loop.
- Multi-file watch resolves the target set at startup, watches the containing
  directories for those files, coalesces by path, and runs batch sync passes with
  bounded concurrency. New files discovered after startup require restarting the
  watcher until a tree manifest/daemon owns dynamic discovery.

The watch core uses a sliding queue and debounce window. Future tests may inject
source streams and `TestClock`, but production code must stay on Effect Platform
watch primitives instead of raw runtime callbacks.

## Long-Term Decisions

Requirement trace: R01-R24. The editor decisions are recorded as individual
records in [`decisions/`](./decisions/) (0001–0017) — that directory is the
authoritative decision log; the table below covers the earlier file-based-engine
areas and must not silently diverge from the records. Decision **0016** (refuse
lossy pages) supersedes the reconciler/converter records (0005, 0010, 0011, 0014,
0015); decision **0017** (edit = ephemeral file-engine session) supersedes 0013
(the stateless schema fingerprint) and broadens the refusal to uniform.

| Area                        | Decision                                                                                                                                                                                                                                                                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Push engine                 | Guarded Markdown push: the stateless `put` is a guarded body replace + typed title write (no stateless property write — 0017); `edit` reuses the file engine's guarded push; the file-based path keeps its three-way Markdown merge + guarded `replace_content`. Pages with lossy/opaque blocks are refused, not reconciled (decisions 0016, 0017). |
| Inline equations            | Treat inline equations conservatively until raw rich-text evidence proves Notion's Markdown endpoint preserves equation semantics. If not, preserve spans outside the body.                                                                                                                                                                         |
| Page/data-source references | Use stock enhanced Markdown where Notion round-trips references. Preserve unsupported references with block API snapshots and object refs.                                                                                                                                                                                                          |
| Property merge bases        | Keep compact bases inline; move large or volatile bases into content-addressed objects by policy.                                                                                                                                                                                                                                                   |
| Comment anchoring           | Bridge Roughdraft comments only when exact selected text is unique in a known block; otherwise fall back to page-level comments.                                                                                                                                                                                                                    |
| Store index                 | Derive reachability from `.nmd` frontmatter and object refs. Add a JSON index only when repo-scale GC or multi-page watch needs it.                                                                                                                                                                                                                 |
| Batch sync                  | Keep the page/file sync engine as the correctness boundary. Batch and folder modes are orchestration only, with duplicate page-id preflight and per-file results.                                                                                                                                                                                   |
| Body completeness           | Keep pure vocabulary in `@overeng/notion-core`, live observation in `@overeng/notion-effect-client`, and clean-base adoption/write policy in `@overeng/notion-md`.                                                                                                                                                                                  |
| Pull body authority         | Adopt block-tree-rendered Markdown as the clean `.nmd` body; retain endpoint Markdown as diagnostic evidence for truncation, unknown blocks, and endpoint/block-tree comparison.                                                                                                                                                                    |
| Webhooks                    | Polling remains the correctness baseline. A local daemon/tunnel may accelerate refresh; hosted relay is a separate product/security decision.                                                                                                                                                                                                       |
| CLI output                  | Use explicit output modes with versioned envelopes. Watch mode uses NDJSON events.                                                                                                                                                                                                                                                                  |
| Watch events                | Use Effect Platform streams plus a deterministic reducer/queue policy. Avoid raw `fs.watch` ownership in package code.                                                                                                                                                                                                                              |

## OpenTelemetry

Requirement trace: R21-R24, R29.

Service names:

| Mode         | `service.name`    |
| ------------ | ----------------- |
| CLI one-shot | `notion-md-cli`   |
| Watch mode   | `notion-md-watch` |

Current implementation uses `notion-md-cli` for both modes and distinguishes watch via attributes. Future process/resource configuration should split them.

Span conventions:

| Span                                | Required attributes                                                                                                                                                                            |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notion-md.cli.<command>`           | `span.label`, `notion_md.command`                                                                                                                                                              |
| `notion-md.cat`                     | `span.label`, `notion_md.page_id`, `notion_md.editor.mode`                                                                                                                                     |
| `notion-md.put`                     | `span.label`, `notion_md.page_id`, `notion_md.editor.mode`, `notion_md.put.force`, `notion_md.put.body_written`, `notion_md.put.title_written`                                                 |
| `notion-md.edit`                    | `span.label`, `notion_md.page_id`, `notion_md.editor.mode`, `notion_md.edit.outcome`; wraps the engine's `notion-md.sync-page` / `push-page` / `status-page` spans as children (decision 0017) |
| `notion-md.sync-page`               | `span.label`, `notion_md.sync.result`, `notion_md.page_id`                                                                                                                                     |
| `notion-md.status-page`             | local/remote changed booleans, unknown-block count                                                                                                                                             |
| `notion-md.push-page`               | force flag, destructive flag, push decision, markdown command                                                                                                                                  |
| `notion-md.watch.sync-pass`         | watch reason, command, path basename, error tag when failed                                                                                                                                    |
| `notion-md.gateway.update-markdown` | page id, update type, content-update count, destructive flag                                                                                                                                   |
| `notion-md.state.read-object`       | object role, hash prefix                                                                                                                                                                       |
| `notion-md.state.write-object`      | object role, hash prefix                                                                                                                                                                       |

Attributes must not include tokens, full Markdown bodies, file bytes, or signed
URLs — asserted by a span leak-guard test (R24, Group G). All attribute keys use
the `notion_md.*` namespace (not a `nmd.*` shorthand). A `result`/`changed`/
`partial_write` attribute per command is desirable hardening not yet emitted
(impl-delta Group G follow-up).

## Verification

| Layer           | Required coverage                                                                 |
| --------------- | --------------------------------------------------------------------------------- |
| Unit            | schemas, canonicalization, merge planner, hash stability, object refs             |
| Fake E2E        | pull/status/push/sync/watch, property/body concurrency, unknown-block guards      |
| State integrity | corrupt hashes, stale objects, path traversal, inventory mismatch, legacy rejects |
| Live Notion E2E | pull/status/push, stale overwrite rejection, unknown blocks, merge, property edit |
| CLI             | command parsing, invalid options, missing token, output contracts                 |
| OTEL            | expected spans and safe attributes                                                |

Implemented verification currently includes:

- pure merge planner tests,
- fake-gateway E2E tests,
- live Notion E2E against a configured parent page,
- live E2E ledger updates on the configured parent page,
- a durable automated demo page synced from `packages/@overeng/notion-md/demo/showcase.nmd`,
- a flat recursive batch demo template under `packages/@overeng/notion-md/demo/workspace/`,
- local `check:quick` and `check:all`.

Live E2E uses `NOTION_TEST_PARENT_PAGE_ID` as a scratch parent. Test-created
child pages are archived during teardown. A stable `notion-md e2e run ledger`
child page records the latest live run so the parent page remains visibly tied
to the test suite without retaining every scratch fixture.

The automated demo page is not a test scratch page. It is the durable 1:1
showcase for local `.nmd` and Notion state. Its local file and reachable object
store entries are committed under `packages/@overeng/notion-md/demo/`.

The batch demo is intentionally a template, not another live fixture set.
Checked-in examples use `.nmd.example` so recursive commands only operate after a
user has pulled distinct real Notion pages into `.nmd` files.

Follow-up hardening remains for required live-lane policy, OTEL span assertions,
versioned CLI output schemas, and broader storage/comment coverage. Watch
coverage already includes polling, structured errors, and batch coalescing in
the fake/live E2E suite; additional watch work should target uncovered lifecycle
or timing edges rather than restating the basic watch-core scenarios.

## Editor Surfaces (`cat` / `put` / `edit`)

Requirement trace: R01, R03, R04, R11, R15. These commands let a human (or pipe)
edit a Notion page as Markdown with the canonical editor instead of a persistent
local file. They are two different shapes (decision 0017):

- **`cat` / `put` — stateless body pipes.** Gateway-only (body facade
  `observeRemoteBody` / `replaceRemoteBodyVerified`): no `.nmd` file, no
  `.notion-md/` store, nothing written anywhere. Pure stdin/stdout. `cat`
  additionally supports a read-only `--frontmatter` envelope dump.
- **`edit` — ephemeral file-engine session.** Sugar over the file-based `sync`
  engine: pull the page into a `.nmd` + `.notion-md/` under `$TMPDIR`, present the
  body in `$EDITOR`, push through `syncPage`, then delete the temp tree. Not a
  second push engine.

### Scope boundary

The **stateless pipes (`cat`/`put`)** operate only on the body + title (decision
0008). Surfaces they do not represent are left untouched on the remote; a user
who needs them uses `edit` or the file-based path. **`edit`**, being engine-backed,
additionally reaches the engine's extras on _representable_ pages.

| Surface                                                        | `cat`/`put`                   | `edit`                     | Notes                                                     |
| -------------------------------------------------------------- | ----------------------------- | -------------------------- | --------------------------------------------------------- |
| body, title                                                    | yes                           | yes                        | the pipe projection                                       |
| writable properties / metadata                                 | `cat --frontmatter` read only | yes (`edit --frontmatter`) | stateless property _write_ dropped (decision 0017)        |
| file bytes / object store                                      | no                            | yes (in `$TMPDIR`)         | hosted media canonicalized either way (0007)              |
| comments, data-source schema                                   | no                            | via engine                 | file/engine only                                          |
| base-snapshot three-way merge                                  | no                            | yes                        | `edit` inherits the engine's 3-way Markdown merge         |
| lossy/opaque blocks (`child_database`, `synced_block`, toc, …) | refused                       | refused                    | uniform refusal at the pull (exit 3, decisions 0016/0017) |
| tree / child-page / move / trash                               | no                            | no                         | file-based `sync`/tree only                               |

### Representation modes

| Mode        | Selector        | Shape                                                 | Available on                      |
| ----------- | --------------- | ----------------------------------------------------- | --------------------------------- |
| Default     | (none)          | `# <title>` then a blank line then the body Markdown  | `cat`, `put`, `edit`              |
| Frontmatter | `--frontmatter` | full `.nmd` envelope (strict JSON frontmatter + body) | `cat` (read), `edit` (read/write) |

Default mode presents the title as a leading H1 (decision 0001); the title is
transport-routed through the typed page API on write, never as a body block.
`--frontmatter` carries the writable projection (title + writable metadata +
writable properties + body). **Stateless `put --frontmatter` is not provided**
(decision 0017): a safe property write needs drift detection, which needs a base
snapshot — so structured property editing is `edit --frontmatter` (interactive,
engine-backed) or the file-based `sync` (scripted). `cat --frontmatter` is a
read-only envelope dump and is always safe in a pipe.

### Title boundary contract (default mode)

| Situation                        | `cat` emits        | `put` behavior                                              |
| -------------------------------- | ------------------ | ----------------------------------------------------------- |
| Page has a title                 | `# <title>` line 1 | line 1 → typed title API; remainder → body                  |
| Untitled page                    | empty `# ` line 1  | empty title round-trips as untitled                         |
| Body has its own leading H1      | title H1 then body | unambiguous: line 1 is the title, the rest is body verbatim |
| Line 1 is **not** a `# ` heading | n/a                | **refuse, fail-loud** — no silent title mutation (T03)      |

The body sent to Notion always has the title H1 stripped (R01). A missing title
line is refused rather than guessed because silently emptying a title is
property-level data loss.

### Guard plumbing

**`cat` / `put` (stateless pipes):**

- `cat` writes the base hash to **stderr** (`base-hash: sha256:…`); **stdout is
  pure Markdown** for clean piping (decision 0002).
- The base hash covers the pipe's writable surface (decision 0006): title + body,
  hosted-media URLs canonicalized (decision 0007), with read-only / computed /
  volatile fields excluded so the hash is stable across pulls and `cat`→`put` is
  idempotent.
- **Canonical serialization (the base hash must be reproducible by an independent
  implementation):** the title+body is serialized as the default-mode `# title`
  - body text with `\n` line endings and hosted-media URLs canonicalized
    (decision 0007), then `sha256` with a `sha256:` prefix. The exact byte form is
    load-bearing for the cross-machine optimistic-concurrency token.
- `put` is guarded by default: it re-reads remote, recomputes the title+body
  hash, and refuses with exit `7` (`NotionMdBodyConflictError`) if it differs
  from `--base-hash`.
- `put` with neither `--base-hash` nor `--force` refuses with guidance. `--force`
  is the explicit destructive mode (R15) and reports that it bypassed the guard.

**`edit` (engine session):** carries **no stderr base hash**. Concurrency safety
comes from the engine's **base snapshot** captured at the ephemeral pull and
compared at `syncPage` push (the same guard the file path uses, decision 0017) —
stronger than the pipe's 2-way hash, since the engine can auto-merge
non-overlapping concurrent edits. In `--frontmatter` mode the engine also detects
data-source **schema drift** from a `schema_snapshot` captured at pull (the
stateless in-buffer fingerprint of decision 0013 is gone). Writable vs
read-only/computed property split is `propertyWriteClassFromType` /
`PROPERTY_WRITE_CLASSES` (`@overeng/notion-core`), the single source of truth.

### Exit codes and error model

Each expected failure is a tagged error (R18) mapped to a distinct exit code for
scriptability:

| Exit | Tagged error                | When                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | —                           | success                                                                                                                                                                                                                                                                                                                                                              |
| 1    | `NmdGatewayError`           | gateway/API failure (network, 5xx, rate-limit) — remote unreachable, distinct from a bad-input failure                                                                                                                                                                                                                                                               |
| 2    | (CLI framework)             | bad flags/args                                                                                                                                                                                                                                                                                                                                                       |
| 3    | `NmdRemoteBodyLossyError`   | **the defining refusal (uniform across `cat`/`put`/`edit`)** — the page contains a not-losslessly-representable block (`child_database`, `synced_block`, `table_of_contents`, `child_page`, API `unsupported`, …) and cannot be edited as Markdown; the message names the block and points to the Notion UI or the file-based `.nmd` sync path (decisions 0016/0017) |
| 4    | `NmdUnresolvablePageError`  | `<page>` not a valid id/URL, or page not found                                                                                                                                                                                                                                                                                                                       |
| 5    | `NmdInvalidDocumentError`   | default mode missing leading title H1; malformed `--frontmatter` envelope                                                                                                                                                                                                                                                                                            |
| 6    | `NmdSchemaDriftError`       | `edit --frontmatter` (and file `sync`): the data-source schema changed since the pull, detected by the engine's `schema_snapshot` comparison (R14); resolve by re-pulling, not by `--force`                                                                                                                                                                          |
| 7    | `NotionMdBodyConflictError` | guard conflict — remote moved since `--base-hash` (`put`), or the engine's base snapshot diverged and 3-way merge failed (`edit`)                                                                                                                                                                                                                                    |
| 8    | `NmdEditorAbortedError`     | `edit`: `$EDITOR` exited non-zero → no push                                                                                                                                                                                                                                                                                                                          |
| 9    | `NmdPostPushGateError`      | post-push `semanticEquivalent` gate rejected the result (the page may be mutated — re-`cat`)                                                                                                                                                                                                                                                                         |
| 10   | `NmdPartialWriteError`      | `put` only: one of the two writes (body, title) landed and the other failed (decision 0012); page is in a mixed state — re-`cat`                                                                                                                                                                                                                                     |

The error family uses the `Nmd*` prefix; the one exception is the pre-existing
`NotionMdBodyConflictError` (exit 7), which keeps its legacy `NotionMd*` name.
Exit 3 is checked **at the pull** on all three verbs (for `edit`, at the
ephemeral file-engine pull) — none of them presents a body it cannot round-trip.
Exit 6 is **redefined**: it is no longer the deleted stateless in-buffer
fingerprint (decision 0013) but the engine's `schema_snapshot`-based schema-drift
refusal for `edit --frontmatter` / `sync` (decision 0017, R14) — kept on its own
axis from the exit-7 value/body conflict so it is not `--force`-able. Exit 11
(opaque-move) is **removed** (no opaque move, decision 0016). Exit 10 applies
only to the stateless `put`; `edit` inherits the engine's settle-and-re-pull.

### Edge behavior

- **Empty body** on `put` is a valid edit (Notion allows an empty body); it is
  applied. `edit` prints a stderr note if the buffer became empty but still
  pushes.
- **`put`/`edit` operate on an existing bound page only.** Page creation stays on
  the file-based / tree path; an unresolvable or nonexistent page is exit 4.
- **`edit` aborts on a non-zero editor exit** (exit 8, nothing pushed).
- **Two writes, body first (decision 0012):** a `put` is body (`replace_content`)
  then title (typed API). If one lands and the other fails it reports which landed
  and exits 10 (which dominates the exit-9 post-push gate); never silent exit 0.
  Recovery is re-`cat`.
- **Title / body H1 sharp edge:** `put` takes line 1 as the title verbatim even
  when line 2 is also `# …`; a page whose first body block is a `heading_1`
  therefore shows two leading `# ` lines in `cat`. This is parser-deterministic
  but visually duplicated; the only protection against an accidental title wipe
  is the missing-title-H1 refusal (exit 5). `replace_content` preserves a body
  that starts with `# Heading` (verified), so the `put` transport does not eat
  it; only Notion's create-from-Markdown absorbs a leading `#` (not used here).
- **Untitled / empty body:** `cat` emits exactly `# ` (hash + single space) on
  line 1 for an untitled page; an untitled, empty-body page is `# \n` only. `put`
  parses the line-1 remainder after `# ` as the title (empty → untitled). The
  exact bytes are load-bearing for the missing-title-H1 check and idempotence.
- **`--frontmatter` mode never treats a body H1 as the title** — the title lives
  in the frontmatter block; a leading `# …` in the body is ordinary content. The
  title-H1 contract is default-mode only.
- **`--force` is concurrency-only** (decision 0009): it bypasses the exit-7 guard
  and nothing else. It does not override the exit-3 lossy refusal, which is
  correctness, not concurrency. Per R15 it reports exactly that it bypassed the
  guard.

### `<page>` resolution

`<page>` accepts a raw page id, a dashed id, or a full Notion URL, resolved
through `parseNotionUuid` from `@overeng/notion-core` (the same contract as
`sync <page-id-or-url>`). An unresolvable value fails fast with guidance (R17).

### `edit` session

`edit` is the canonical-editor convenience and an **ephemeral file-engine
session** (decisions 0003, 0017) — sugar over the `sync` engine, not a separate
push path:

1. `mktemp -d` a session dir under `$TMPDIR` (never the cwd) and `pullPage` the
   page into `<dir>/page.nmd` + `<dir>/.notion-md/`. The pull's
   `assertRemoteMarkdownComplete` gate refuses a lossy page here (exit 3),
   exactly like `cat`/`put`.
2. Present the body to `$VISUAL` → `$EDITOR` → `vi` — default mode strips the
   frontmatter and shows `# <title>` + body; `--frontmatter` shows the full
   envelope. Wait for exit.
3. On a non-zero editor exit, abort (exit 8), nothing pushed.
4. On an unchanged buffer, no-op.
5. Otherwise splice the edit back into the envelope (parse line-1 title H1 into
   the frontmatter title in default mode) and `syncPage` the temp `.nmd`. Because
   every accepted page is representable, `edit` uses a full-body `replace_content`
   (decision 0017), closing the targeted-update silent-partial-apply window.
6. On a conflict the engine writes a `.conflict.roughdraft.md`; `edit` **copies
   it out of `$TMPDIR`** to a durable sibling (`<page>.conflict.md`) and prints
   recovery guidance.
7. Always scope-clean the session dir (success / conflict / abort / interrupt).

No editor plugin is shipped; `edit` works with any `$EDITOR` (decision 0003).

### Umbrella surface

The commands appear as `notion-md cat|put|edit` standalone and `notion md
cat|put|edit` through the umbrella dispatch. `edit` is additionally promoted to
the top-level alias `notion edit <page>` (decision 0004).

## Refusing Lossy Pages (uniform)

Requirement trace: R12, R38, Success Criterion 4. Decisions 0016, 0017.

The editor serves the **representable-Markdown majority** and refuses the rest.
A page whose body contains any **not-losslessly-representable block** is refused
(exit 3) **at the pull** — uniformly across `cat`, `put`, and `edit` (and the
file-based `sync`, which refuses at the same gate). Refusal is a property of the
shared core, not a streaming-only carve-out: `edit` materializes through the same
`pullPage` whose `assertRemoteMarkdownComplete` gate fires the refusal (decision
0017), so it refuses the same pages the pipes do.

The refusal criterion is **"not losslessly round-trippable"** — broader than the
API `unsupported` type. It covers `unsupported` plus known-but-lossy blocks:
`child_database` (renders `[embedded db]()`), `synced_block`,
`table_of_contents`, `breadcrumb` (renders `''`), `child_page`, and similar. The
body-fidelity classifier (`@overeng/notion-core`), which today flags only
`unsupported`, must be extended to flag every such block (R38, impl-delta Group
C). This is a **correctness prerequisite for the file path too**: today
`child_database`/`toc` classify `complete`, so without the extension a
`replace_content` push (file `sync` or `edit`) would silently destroy them.

- **Refusal, not placeholdering.** The reconciler/placeholder approach (former
  decisions 0005/0011) was abandoned: Notion's platform bars the parts of it that
  matter — no backlink endpoint (a moved `synced_block` original silently breaks
  inbound references), `child_database` is uncreatable via the block API, and the
  Markdown endpoint is non-injective. Refusing is the honest, elegant scope the
  platform permits (decision 0016).
- **Message.** The exit-3 error names the offending block class and points the
  user to the **Notion UI** to edit that block. The refusal is shared with the
  file-based `sync` (same pull gate), so it is not a workaround to switch to
  `sync` for these blocks.
- **Representable majority.** A page of paragraphs, headings, lists, to-dos,
  quotes, code, callouts, toggles, tables, columns, equations, and **hosted or
  external media** (media is representable — only its URL is volatile, decision 0007) round-trips cleanly and is fully editable.
- **Out-of-band preservation is for _round-trip-safe_ captures, not a lossy
  escape hatch.** The file path's `unsupported_blocks` + object-store machinery
  (Feature Mapping) captures files, media, and resolvable payloads on pages that
  classify _complete_. Post-R38 **no page containing a not-round-trip-safe block
  classifies `complete`** — such pages are refused at the pull on every surface —
  so that machinery never applies to a not-round-trip-safe body block. The
  pre-R38 "preserve any unsupported body block + `allow_deleting_content`
  override" behavior is retired: live testing proved it silently corrupts
  (experiments.md). Lossy pages are edited in Notion.

## Hosted-Media References

Requirement trace: R10, R36. Decision 0007. Live-validated in experiments.md.

Notion-hosted media (image/file/video/pdf with `type: "file"`) renders with an
expiring signed S3 URL (`X-Amz-*`) that **rotates on every pull**. Left raw, it
makes the body hash volatile (breaking `cat`→`put` idempotence and staling base
hashes with zero edits) and causes `update_content` pushes on media pages to be
rejected by the post-push gate.

- Hosted-media URLs are **canonicalized** — strip the `X-Amz-*` / signature /
  `Expires` query params, keep `origin + pathname` — at **every** point a body
  is hashed, diffed, base-tracked, or gated, **including inside
  `semanticEquivalent` / `canonicalizeBlockMarkdown`**.
- External (stable) URLs are left untouched and pushed as external media.
- The canonicalized URL is deterministic but not directly fetchable; acceptable
  for an editing surface (the user edits text, not media URLs). Canonicalization
  governs hashing/diffing/gating only; the live file stays authoritative on the
  remote.

## Push Strategy and Canonical Base

Because the page is refused unless its body is fully representable (decision
0016), the stateless `put` is a **guarded body replace plus a typed title write**
— no block-level reconciliation, no client-side Markdown→block converter, no
stateless property write (decision 0017). The body goes through Notion's own
`replace_content` parser server-side (`replaceRemoteBodyVerified`); since the
body contains no opaque blocks, `replace_content` can never destroy one. (`edit`
takes a different path — it reuses the file engine's guarded push; see the `edit`
session.)

- `put` writes the body via `replaceRemoteBodyVerified` (guarded by the base
  hash), then the title via the typed page API — **two writes, body first**
  (decision 0012). `put` has no `--frontmatter`; writable-property editing is
  `edit --frontmatter` or the file-based `sync`.
- A partial failure (one write landed, the other failed) reports which landed and
  exits 10; this dominates the exit-9 post-push gate (decision 0012).
- The post-push `semanticEquivalent` gate runs with hosted-media URL
  canonicalization (decision 0007).
- **Base = the canonical body, and only ever the value `cat` emitted.** Notion
  canonicalizes lists, ordered-list counters, code-fence language, and blank
  lines at write time, so the editor adopts the canonical body returned by the
  first pull as the base. The base hash is the value `cat` printed to stderr; a
  client must **never** recompute it locally over the editable buffer (which is
  pre-canonical until the next pull).
