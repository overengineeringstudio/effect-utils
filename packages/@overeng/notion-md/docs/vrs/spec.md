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
Batch/workspace orchestrator
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

| Surface            | Local state                    | Pull API                   | Push API                    | Conflict unit      | Current status              |
| ------------------ | ------------------------------ | -------------------------- | --------------------------- | ------------------ | --------------------------- |
| Body               | `.nmd` body + `base_snapshot`  | `GET /pages/{id}/markdown` | Markdown update endpoint    | canonical Markdown | implemented                 |
| Page metadata      | frontmatter page fields        | `GET /pages/{id}`          | `PATCH /pages/{id}`         | field              | title/lock/trash/icon/cover |
| Properties         | frontmatter property map       | `GET /pages/{id}`          | `PATCH /pages/{id}`         | property           | modeled writable forms      |
| Unsupported blocks | frontmatter/object storage     | Markdown + block API       | preserve or explicit delete | block id           | guard + preserve metadata   |
| Data-source schema | external datasource-sync state | datasource-sync package    | datasource-sync package     | schema hash        | owned by datasource sync    |
| Comments           | future comment payload         | comments API               | comments API                | discussion/comment | designed, not implemented   |
| Files              | future file payload            | block/file APIs            | file upload APIs            | content hash       | modeled, not implemented    |
| Review             | Roughdraft local markup        | local only or comments API | explicit bridge only        | review id          | guard implemented           |

Body conflicts do not block property-only pushes. Property-only pushes across a concurrent remote body edit patch properties, then refresh the local `.nmd` body and base from the current remote state.

## Pull Flow

1. Decode CLI options.
2. Retrieve Notion page metadata.
3. Retrieve body Markdown.
4. Retrieve unknown block payloads through the block API when Markdown reports unknown/truncated blocks.
5. Canonicalize Markdown and compute the body hash.
6. Build a strict frontmatter envelope.
7. Write base snapshot and storage objects.
8. Write the `.nmd` file.
9. Emit a pull result with storage mode and object refs.

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
3. Reject unresolved Roughdraft review markup unless explicitly allowed.
4. Reject body pushes that could delete unknown blocks unless destructive intent is explicit.
5. If only page metadata or properties changed and the remote body changed, patch those surfaces and refresh local body from remote.
6. If the remote body changed and local body changed, attempt a conservative three-way merge.
7. If merge succeeds, update Markdown and then properties.
8. If merge fails, write a Roughdraft conflict artifact and leave remote unchanged.
9. If remote body is still at base, use a targeted Markdown update when safe or guarded replace when necessary.
10. Pull remote after writes and rewrite `.nmd` with fresh body, base, page metadata, and storage.

The local file is read once for a push decision to avoid local snapshot drift. Remote body is re-read immediately before guarded Markdown updates to catch races between status and write.

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

| Notion feature              | Local body representation               | Non-body state                  | Fidelity / policy                     |
| --------------------------- | --------------------------------------- | ------------------------------- | ------------------------------------- |
| Page title/icon/cover       | not body                                | frontmatter page fields         | title preserved; icon/cover modeled   |
| Page lock/trash state       | not body                                | frontmatter page fields         | field-level page API patch            |
| Paragraphs, headings, lists | stock Markdown/enhanced Markdown        | none                            | supported with Notion normalization   |
| To-dos, quotes, dividers    | stock Markdown/enhanced Markdown        | none                            | supported                             |
| Code blocks                 | fenced blocks                           | language normalization          | supported; aliases may normalize      |
| Equations                   | Markdown/enhanced math syntax           | raw rich-text fallback if lossy | block supported; inline conservative  |
| Callouts, toggles, tables   | enhanced Markdown tags                  | color/attribute normalization   | supported with normalization caveats  |
| Columns                     | enhanced column tags                    | none                            | supported by endpoint, needs coverage |
| Images/files/media          | Markdown/enhanced media tags            | future file payloads            | not fully implemented                 |
| Bookmark/embed/link preview | `<unknown ...>` placeholder             | unsupported block unit/object   | preserve or explicit delete           |
| Child page/database         | enhanced reference tags or placeholders | future ownership records        | preserve by default                   |
| Data-source row properties  | not body                                | typed property map              | modeled writable properties           |
| Data-source schema/views    | not body                                | future schema snapshot          | not implemented                       |
| Comments                    | not body                                | future comment bridge           | not implemented                       |
| Suggestions/review          | Roughdraft local layer                  | review state                    | reject unresolved by default          |

Known Notion enhanced Markdown limitations:

- Notion normalizes valid Markdown on pull.
- Page title and properties are not included in Markdown body output.
- Some blocks pull as `<unknown>` with `unknown_block_ids`.
- Signed file URLs expire and are not durable identity.
- Comments support inline Markdown-like content but are separate from body Markdown.
- `allow_deleting_content` can delete child pages/databases and unsupported blocks; the default is non-destructive.

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
notion-md sync <page-id-or-url> docs
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
- Multiple status targets or recursive unmanaged directory targets emit a batch envelope.
- Managed workspace directories read `.notion-md/workspace.json`; `sync`
  materializes missing remote child pages, while `status` reports them without
  writing files.
- Unmanaged directory targets require `--recursive`.
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
  watcher until a workspace manifest/daemon owns dynamic discovery.

The watch core uses a sliding queue and debounce window. Future tests may inject
source streams and `TestClock`, but production code must stay on Effect Platform
watch primitives instead of raw runtime callbacks.

## Long-Term Decisions

Requirement trace: R01-R24.

| Area                        | Decision                                                                                                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inline equations            | Treat inline equations conservatively until raw rich-text evidence proves Notion's Markdown endpoint preserves equation semantics. If not, preserve spans outside the body. |
| Page/data-source references | Use stock enhanced Markdown where Notion round-trips references. Preserve unsupported references with block API snapshots and object refs.                                  |
| Property merge bases        | Keep compact bases inline; move large or volatile bases into content-addressed objects by policy.                                                                           |
| Comment anchoring           | Bridge Roughdraft comments only when exact selected text is unique in a known block; otherwise fall back to page-level comments.                                            |
| Store index                 | Derive reachability from `.nmd` frontmatter and object refs. Add a JSON index only when repo-scale GC or multi-page watch needs it.                                         |
| Batch sync                  | Keep the page/file sync engine as the correctness boundary. Batch and folder modes are orchestration only, with duplicate page-id preflight and per-file results.           |
| Webhooks                    | Polling remains the correctness baseline. A local daemon/tunnel may accelerate refresh; hosted relay is a separate product/security decision.                               |
| CLI output                  | Use explicit output modes with versioned envelopes. Watch mode uses NDJSON events.                                                                                          |
| Watch events                | Use Effect Platform streams plus a deterministic reducer/queue policy. Avoid raw `fs.watch` ownership in package code.                                                      |

## OpenTelemetry

Requirement trace: R21-R24, R29.

Service names:

| Mode         | `service.name`    |
| ------------ | ----------------- |
| CLI one-shot | `notion-md-cli`   |
| Watch mode   | `notion-md-watch` |

Current implementation uses `notion-md-cli` for both modes and distinguishes watch via attributes. Future process/resource configuration should split them.

Span conventions:

| Span                                | Required attributes                                           |
| ----------------------------------- | ------------------------------------------------------------- |
| `notion-md.cli.<command>`           | `span.label`, `notion_md.command`                             |
| `notion-md.sync-page`               | `span.label`, `notion_md.sync.result`, `notion_md.page_id`    |
| `notion-md.status-page`             | local/remote changed booleans, unknown-block count            |
| `notion-md.push-page`               | force flag, destructive flag, push decision, markdown command |
| `notion-md.watch.sync-pass`         | watch reason, command, path basename, error tag when failed   |
| `notion-md.gateway.update-markdown` | page id, update type, content-update count, destructive flag  |
| `notion-md.state.read-object`       | object role, hash prefix                                      |
| `notion-md.state.write-object`      | object role, hash prefix                                      |

Attributes must not include tokens, full Markdown bodies, file bytes, or signed URLs.

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
- a recursive workspace demo template under `packages/@overeng/notion-md/demo/workspace/`,
- local `check:quick` and `check:all`.

Live E2E uses `NOTION_TEST_PARENT_PAGE_ID` as a scratch parent. Test-created
child pages are archived during teardown. A stable `notion-md e2e run ledger`
child page records the latest live run so the parent page remains visibly tied
to the test suite without retaining every scratch fixture.

The automated demo page is not a test scratch page. It is the durable 1:1
showcase for local `.nmd` and Notion state. Its local file and reachable object
store entries are committed under `packages/@overeng/notion-md/demo/`.

The workspace demo is intentionally a template, not another live fixture set.
Checked-in examples use `.nmd.example` so recursive commands only operate after a
user has pulled distinct real Notion pages into `.nmd` files.

Follow-up hardening remains for required live-lane policy, OTEL span assertions,
versioned CLI output schemas, and broader storage/comment coverage. Watch
coverage already includes polling, structured errors, and batch coalescing in
the fake/live E2E suite; additional watch work should target uncovered lifecycle
or timing edges rather than restating the basic watch-core scenarios.
