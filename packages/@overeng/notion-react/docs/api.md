# API overview

Hand-curated index of the public surface. Authoritative signatures live
on the source — click through for the full types. This page is the
map, not the reference.

## Entry points

```ts
import { renderToNotion, sync } from '@overeng/notion-react'
```

| Export           | Source                                                                | Purpose                                                                                                 |
| ---------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `renderToNotion` | [`renderer/render-to-notion.ts`](../src/renderer/render-to-notion.ts) | Cold-start append; no cache. Returns `Effect<SyncResult, NotionSyncError, NotionConfig \| HttpClient>`. |
| `sync`           | [`renderer/sync.ts`](../src/renderer/sync.ts)                         | Incremental cache-backed sync. Same return type.                                                        |
| `collectOps`     | [`renderer/render-to-notion.ts`](../src/renderer/render-to-notion.ts) | Collect an `OpBuffer` from a one-shot render. Exposed for tests.                                        |
| `SyncResult`     | [`renderer/render-to-notion.ts`](../src/renderer/render-to-notion.ts) | `{ appends, updates, removes, inserts, fallbackReason? }`                                               |

## Block components

From `@overeng/notion-react` (Notion host) and
`@overeng/notion-react/web` (DOM mirror). Shared prop shapes in
[`src/components/props.ts`](../src/components/props.ts).

| Component                                                    | Notion block type                                               | Notes                                                                               |
| ------------------------------------------------------------ | --------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `Page`                                                       | (fragment)                                                      | Root container.                                                                     |
| `Paragraph`                                                  | `paragraph`                                                     | Rich-text children, `blockKey?`.                                                    |
| `Heading1` / `Heading2` / `Heading3` / `Heading4`            | `heading_1..4`                                                  | `toggleable?`, `color?`, `blockKey?`.                                               |
| `BulletedListItem` / `NumberedListItem`                      | `bulleted_list_item`, `numbered_list_item`                      | Rich-text children, `blockKey?`.                                                    |
| `ToDo`                                                       | `to_do`                                                         | `checked?`, `blockKey?`.                                                            |
| `Toggle`                                                     | `toggle`                                                        | `title`, nested block children, `blockKey?`.                                        |
| `Code`                                                       | `code`                                                          | `language?`, `blockKey?`.                                                           |
| `Quote`                                                      | `quote`                                                         | Rich-text children, `blockKey?`.                                                    |
| `Callout`                                                    | `callout`                                                       | `icon?` (string or `{ external: url }`), `color?`, `blockKey?`.                     |
| `Divider`                                                    | `divider`                                                       |                                                                                     |
| `Image` / `Video` / `Audio` / `File` / `Pdf`                 | `image` / `video` / `audio` / `file` / `pdf`                    | `url?` or `fileUploadId?`, `caption?`.                                              |
| `Bookmark` / `Embed`                                         | `bookmark`, `embed`                                             | `url`.                                                                              |
| `Equation`                                                   | `equation`                                                      | `expression`.                                                                       |
| `Table` / `TableRow`                                         | `table`, `table_row`                                            | `tableWidth?`, `hasColumnHeader?`, `hasRowHeader?` / `cells`.                       |
| `ColumnList` / `Column`                                      | `column_list`, `column`                                         | `widthRatio?` on `Column`.                                                          |
| `LinkToPage`                                                 | `link_to_page`                                                  | `pageId`.                                                                           |
| `TableOfContents`                                            | `table_of_contents`                                             |                                                                                     |
| `ChildPage`                                                  | `child_page`                                                    | `title?`.                                                                           |
| `Breadcrumb`                                                 | `breadcrumb`                                                    | Passthrough.                                                                        |
| `Raw`                                                        | (any)                                                           | Escape hatch: `type` + `content`. See [Custom blocks](./cookbook/custom-blocks.md). |
| `Template` / `LinkPreview` / `SyncedBlock` / `ChildDatabase` | `template` / `link_preview` / `synced_block` / `child_database` | Thin `<Raw>` wrappers.                                                              |

See [`src/components/blocks.tsx`](../src/components/blocks.tsx) for
signatures.

## Inline components

From `@overeng/notion-react` (Notion host) and
`@overeng/notion-react/web`. Source:
[`src/components/inline.tsx`](../src/components/inline.tsx).

| Component        | Effect                                            |
| ---------------- | ------------------------------------------------- |
| `Bold`           | `bold: true` annotation.                          |
| `Italic`         | `italic: true`.                                   |
| `Strikethrough`  | `strikethrough: true`.                            |
| `Underline`      | `underline: true`.                                |
| `InlineCode`     | `code: true`.                                     |
| `Color`          | `color: value` (Notion color token).              |
| `Text`           | Passthrough; explicit inline wrapper.             |
| `Link`           | Hyperlink; `href` prop.                           |
| `Mention`        | Notion mention envelope; `mention`, `plainText?`. |
| `InlineEquation` | KaTeX-style equation; `expression`.               |

Inline components compose: `<Bold><Link href="…"><Italic>…</Italic></Link></Bold>`
produces the expected nested annotations in a single `rich_text[]`
entry.

## Keys

```ts
import { blockKey } from '@overeng/notion-react'
blockKey('task-42') // "b:task-42"
```

Namespaces a business id so multiple renderers can share a cache
without collisions. See
[Concepts → Keys and identity](./concepts/keys-and-identity.md).

## Cache

```ts
import {
  FsCache,
  InMemoryCache,
  type NotionCache,
  CACHE_SCHEMA_VERSION,
} from '@overeng/notion-react'
```

| Export                    | Source                                                        | Purpose                                                                        |
| ------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `FsCache.make(path)`      | [`cache/fs-cache.ts`](../src/cache/fs-cache.ts)               | JSON file; atomic rename on save; cold-cache on schema mismatch.               |
| `InMemoryCache.make()`    | [`cache/in-memory-cache.ts`](../src/cache/in-memory-cache.ts) | In-process; tests and ephemeral runs.                                          |
| `NotionCache`             | [`cache/types.ts`](../src/cache/types.ts)                     | Implement `load` / `save` to add your own backend.                             |
| `CACHE_SCHEMA_VERSION`    | [`cache/types.ts`](../src/cache/types.ts)                     | Current on-disk schema version (`3`). Mismatches trigger a cold-diff fallback. |
| `CacheTree` / `CacheNode` | [`cache/types.ts`](../src/cache/types.ts)                     | `Schema.Schema` + `interface` for cache payloads.                              |

## Errors

```ts
import { NotionSyncError, CacheError } from '@overeng/notion-react'
```

| Error             | Reasons (so far)                                                                                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NotionSyncError` | `"notion-append-failed"`, `"notion-insert-failed"`, `"notion-update-failed"`, `"notion-delete-failed"`, `"notion-retrieve-failed"`, `"cache-load-failed"`, `"cache-save-failed"` |
| `CacheError`      | `"fs-cache-read-failed"`, `"fs-cache-parse-failed"`, `"fs-cache-write-failed"`                                                                                                   |

Both are `Data.TaggedError` classes with `reason: string` and optional
`cause: unknown`.

## Uploads

```ts
import {
  UploadRegistryProvider,
  useNotionUpload,
  type UploadRegistry,
  type UploadRecord,
} from '@overeng/notion-react'
```

v0.1 upload path is pre-resolve: the caller populates an
`UploadRegistry`, wraps the tree in `UploadRegistryProvider`, and
components look up uploads synchronously via `useNotionUpload(hash,
factory)`. A Suspense-backed variant ships in v0.2. See
[`src/renderer/upload-registry.ts`](../src/renderer/upload-registry.ts).

## Web renderer

```ts
import { Page, Heading1, Paragraph /* … same surface */ } from '@overeng/notion-react/web'
import '@overeng/notion-react/web/styles.css'
```

Mirrors the Notion-host component surface for Storybook / browser
preview. Not API-stable — DOM, class names, and prop behaviour may
change without deprecation (T05 in
[requirements.md](./vrs/requirements.md)). See
[Cookbook → Styling strategies](./cookbook/styling-strategies.md).

## Test helper

```ts
import { … } from '@overeng/notion-react/test'
```

Re-exports the e2e harness from
[`src/test/integration/e2e/helpers.ts`](../src/test/integration/e2e/helpers.ts).
Not part of the stable surface; exposed so downstream packages can
drive the same scratch-page harness against their own test workspaces.

## Advanced exports (diff internals)

Exposed for tests and for tooling that wants to inspect a plan
without applying it. Stability is best-effort.

| Export                                                                                   | Source                                                                  |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `buildCandidateTree`, `candidateToCache`                                                 | [`renderer/sync-diff.ts`](../src/renderer/sync-diff.ts)                 |
| `diff`, `tallyDiff`, `stableStringify`                                                   | [`renderer/sync-diff.ts`](../src/renderer/sync-diff.ts)                 |
| `CandidateNode`, `CandidateTree`, `DiffOp`                                               | [`renderer/sync-diff.ts`](../src/renderer/sync-diff.ts)                 |
| `createNotionRoot`, `NotionReconciler`, `walkInstances`, `blockChildren`, `projectProps` | [`renderer/host-config.ts`](../src/renderer/host-config.ts)             |
| `OpBuffer`, `Op`                                                                         | [`renderer/op-buffer.ts`](../src/renderer/op-buffer.ts)                 |
| `flattenRichText`, `INLINE_TAG`, inline types                                            | [`renderer/flatten-rich-text.ts`](../src/renderer/flatten-rich-text.ts) |
