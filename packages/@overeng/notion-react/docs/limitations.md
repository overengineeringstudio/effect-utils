# Limitations

Known gaps, deliberate deferrals, and behavioural caveats of
`@overeng/notion-react`. Everything here is explicit — you will not hit a
silent failure for any of these, but you may need to pick an alternative
approach.

Cross-references: [vision](./vrs/vision.md) · [requirements](./vrs/requirements.md) · [spec](./vrs/spec.md).

## Out of scope by design

### Database-parented pages (DQ6)

`<ChildPage>` in v1 only targets **page-parented** sub-pages. Creating a
page under a Notion database would require custom `properties` keyed by
the database's schema plus a discriminated-union `parent` on
`<ChildPage>`. The prop shape was designed to allow this without a
schema change, but wiring it is deferred. If you need a database-parented
page, call `NotionPages.create` imperatively and render the result as a
read-only reference via the two-step pattern (see
[cookbook/sub-page-creation](./cookbook/sub-page-creation.md)).

### Intra-parent sibling-page reorder (DQ7)

Notion's `pages.move` endpoint only changes a page's parent; it cannot
reorder sub-pages under the same parent. Reordering `<ChildPage>`
siblings in JSX while keeping the same parent is **not supported** —
the renderer keeps the existing server order and does not emit any op.
Emulating reorder via archive + recreate would lose the page id and its
history. If sibling order matters to your UX, place the ordering concern
in your own state (e.g. a database with a sort property) rather than in
JSX structure.

### Non-title page properties on `<Page>` / `<ChildPage>`

Only `title`, `icon`, and `cover` are projected. Properties set on a
database-parented page (custom typed fields, relations, formulas, etc.)
are not modeled. See DQ6 — they travel with database-parented pages and
share the same deferral.

### `is_locked`, `erase_content`

Rare page-level controls that `NotionPages.update` exposes. Not
surfaced on the component API. Callers that need them drop to the
imperative path via `@overeng/notion-effect-client`.

### Async uploads inside newly-created sub-pages

Covered by R15 / T03: v0.1 requires uploads to be pre-resolved via
`UploadRegistry` before the sync runs. A Suspense-backed path is
tracked separately and unrelated to the page-ops work.

## Behavioural caveats

### No idempotency primitive (A09 / T06)

The Notion API exposes no idempotency key or client request token. If a
sync is interrupted mid-flight:

- `pages.create` succeeded but the follow-up block ops fail → the
  newly-created page is archived and the error surfaces with
  `fallbackReason: "partial-page-create"`. The next sync reconciles by
  id; the orphan stays archived.
- Any other partial failure → checkpointed cache reflects exactly what
  landed on the server; the next sync diffs against reality.

You cannot atomically create "this page plus all its content" — the
surface is coarsely best-effort and the recovery story is archive-and-retry.

### No cross-page op batching (T07)

Block ops are batched up to 100 children per `NotionBlocks.append` call.
Page ops (`createPage`, `updatePage`, `archivePage`, `movePage`) are
always individual requests. Sub-page boundaries cut batch windows. Page
ops are rare relative to block ops, so this rarely matters in practice.

### Inline children on page create — depth ≤ 2, ≤ 100 blocks (A08)

`pages.create` accepts nested `children[]` up to two levels deep.
Deeper subtrees are landed via follow-up `blocks.children.append` calls
scoped to the newly created page. This is handled transparently by
`inlinePackChildren`; you do not need to structure your JSX around it.

### Title length cap — 2000 chars per rich_text span (A10)

Each title rich_text span is capped at 2000 characters. Titles longer
than that must be split across multiple spans (pass a `PageTitleSpan[]`
instead of a plain string to `title`).

### Icon / cover response shape differs from request shape (A07)

Notion rewrites certain icon payloads on the round-trip:

- `external` URLs pointing at Notion's built-in SVG icons come back as
  `{type:"icon", icon:{name, color}}`. The normalizer folds both sides
  into the same canonical form, so diff-hash equality holds across
  runs.
- `custom_emoji` entries with an unknown or missing id come back as
  `null`. The component layer strips these at call time with a
  `console.warn` (same policy as the UploadRegistry miss in DQ5).

Cover accepts only `external` and `file_upload` — `emoji` /
`custom_emoji` covers are rejected by the API. This narrower
`PageCover` type catches the mistake at compile time.

### Clearing `icon` / `cover` requires the `null` sentinel

Dropping the `icon` or `cover` prop between renders is "no claim" and
preserves the server-side field. To clear a previously-set icon or
cover, pass `null` explicitly: `<ChildPage icon={null} />` /
`<ChildPage cover={null} />`. The next sync emits `pages.update({icon:
null})` / `pages.update({cover: null})`. See
[API → Page types](./api.md#page-types).

### Rate-limit signals are in the response body, not headers (A09)

Notion does not expose `x-ratelimit-*` or `retry-after` HTTP headers.
Back-pressure on 429 must read the response body's `retry_after` field.
Our `@overeng/notion-effect-client` handles this transparently under
`retryEnabled: true`, but if you layer your own retry on top, don't rely
on headers.

## Web renderer (Storybook preview)

### Not API-stable (T05)

The companion web renderer exists for Storybook / design iteration.
Its DOM output, CSS hooks, and component props may change without a
deprecation cycle. Do not target it as a production React-DOM render
path.

### Icon / cover visual rendering (gap)

The web mirrors for `<Page>` and `<ChildPage>` currently ignore
`icon` and `cover` props — the new stories document the JSX surface but
don't render those visually. A pass over `src/web/blocks.tsx` to mirror
the icon/cover rendering would make Storybook a better visual test bed;
filed as a follow-up.

## Migration & caching

### Cache schema migrations are cold-rebuilds

Bumping `CACHE_SCHEMA_VERSION` invalidates the existing cache via the
`"schema-mismatch"` fallback. The next sync is a cold rebuild against
server reality — no data loss, but also no op-minimality for that one
run. See [migration.md](./migration.md) for the v2 → v3 transition.

### Owned-region assumption (A04 / T01)

Anything inside the reconciled page tree is treated as solely owned by
the renderer. Concurrent human edits inside regions the renderer
controls **will** be overwritten on the next sync. Scope the renderer
to a dedicated sub-tree if you need a mixed-ownership page.
