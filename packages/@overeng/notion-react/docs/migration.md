# Migration notes

The package is pre-1.0. Minor bumps (0.1 → 0.2 → …) may include
breaking changes, documented here in reverse chronological order.
Patch bumps (0.1.x) are always non-breaking. A proper versioned
migration guide appears when v1.0 ships.

## Unreleased (v0.2, in flight)

Planned breaking changes tracked on the branch, not yet released:

- **Nested blocks under `callout` / `quote` / list-item / `to_do`.**
  v0.1 treats these parents as rich-text-only. v0.2 reconciles their
  block children. Existing trees that rely on rich-text-only behaviour
  keep working; new usage can nest blocks directly.
- **Suspense-backed uploads.** `useNotionUpload` gains an async path.
  The v0.1 synchronous behaviour (pre-resolve via `UploadRegistry`)
  still works; Suspense becomes the recommended path for new code.
- **`block-missing` fallback.** The sync driver gains automatic
  handling for cache-referenced blocks that 404 at update time.
  Currently surfaces as `NotionSyncError { reason: "notion-update-failed" }`.

Track progress in the [repo issues](https://github.com/overengineeringstudio/effect-utils/issues).

## v0.1 (current)

Initial public API. Everything listed in the [API overview](./api.md)
is stable within the 0.1.x line:

- `renderToNotion`, `sync`, `SyncResult`, `NotionSyncError`.
- `NotionCache` interface, `FsCache`, `InMemoryCache`.
- Block and inline components under `@overeng/notion-react` and
  `@overeng/notion-react/web`.
- `blockKey` helper; `blockKey` prop on `Heading1..4`, `Toggle`,
  `Callout`.
- `CACHE_SCHEMA_VERSION = 3`.

Known limitations (not bugs — tracked for v0.2):

- `callout` / `quote` / list-item / `to_do` children are rich-text
  only. Nested blocks require `Toggle` in v0.1.
- `useNotionUpload` is synchronous only.
- Media blocks (`video`, `audio`, `file`, `pdf`) support external URLs
  only; `file_upload` envelope lands with the Notion API
  `file_upload` surface.

## Cache migrations

The on-disk cache schema version is currently `3`. Bumping it
invalidates every existing cache file; the sync driver falls back to
a cold-start diff against the stale tree (`fallbackReason =
"schema-mismatch"`). No data is corrupted — keys still match where
they can, so the first post-migration sync is usually close to a
no-op plus a cache rewrite.

To force-clear a cache manually, delete the JSON file (or whichever
storage the backend uses). `sync` treats a missing cache as cold
(`fallbackReason = "cold-cache"`).
