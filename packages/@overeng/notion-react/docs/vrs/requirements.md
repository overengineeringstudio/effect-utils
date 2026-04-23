# Requirements — @overeng/notion-react

## Context

Builds on [vision.md](./vision.md). Requirements are testable constraints
on the library as a whole; they do not prescribe how the reconciler,
host-config, or cache are implemented (see [spec.md](./spec.md) for that).

## Assumptions

- **A01 Notion block model:** Notion pages are trees of typed blocks with
  stable ids, rich-text payloads, and an append/insert/update/delete API
  surface. The library builds on `@overeng/notion-effect-client` and
  `@overeng/notion-effect-schema`.
- **A06 Block / page API boundary:** Pages and blocks are distinct API
  resources. `child_page` blocks cannot be created or updated via the block
  API; page creation, metadata updates, and archival go through
  `NotionPages.create` / `NotionPages.update`. A `pages.create` response
  auto-materializes a `child_page` block in the parent whose id equals the
  new page id.
- **A07 Page metadata is per-response normalized:** Notion may rewrite
  icon/cover payloads on the round-trip (built-in icon URLs resolve to an
  undocumented `{type:"icon", icon:{name,color}}` shape; unknown
  `custom_emoji` ids silently drop to `null`). Equivalence checks must
  normalize on response shape, not request shape.
- **A08 Inline-child depth on create ≤ 2:** `pages.create` accepts nested
  `children[]` up to two levels deep; deeper subtrees must be landed with
  follow-up `blocks.children.append` calls. Per-request child count is
  capped at 100 for both `pages.create` and `blocks.children.append`.
- **A09 No idempotency primitive:** The Notion API exposes no idempotency
  key or client token. Recovery from partial failure is archive-and-retry,
  keyed by correlating JSX identity to page ids through the cache. Archived
  pages remain retrievable via `pages.retrieve` / `blocks.retrieve`; only
  `blocks.children.list` returns 404 on an archived page.
- **A10 Title length:** Each title rich_text span is capped at 2000
  characters. Callers that need longer titles must split across spans.
- **A02 Effect callers:** Downstream callers run in Effect and can provide
  `NotionConfig` + `HttpClient` in their runtime.
- **A03 React 19 + react-reconciler:** Rendering uses `react@19` and
  `react-reconciler` as the host-config target. The library pins both
  versions and manages upgrades explicitly per
  [react-derisk-report](../../../../../context/pixeltrail/notion-page-sync/react-derisk-report.md).
- **A04 Single-writer page region:** The portion of the page reconciled by
  this library is treated as solely owned by the renderer. Human edits
  inside that region may be overwritten.
- **A05 Notion reorder has no move:** Notion's block API cannot move a
  block; reorders materialize as remove + re-insert.

## Acceptable Tradeoffs

- **T01 Overwrites within owned region:** The renderer does not merge
  concurrent human edits inside regions it controls. Downstreams wanting
  merge must scope the renderer to a dedicated sub-tree.
- **T02 Tail-append bias on unkeyed siblings:** When siblings lack
  `blockKey`/React `key`, mid-sibling inserts degrade to reorders
  (remove + re-insert of the tail). This is acceptable because it's
  documented and the mitigation (supply a key) is cheap.
- **T03 Synchronous-by-default uploads:** v0.1 requires uploads to be
  pre-resolved before render. Interleaved upload + render (Suspense) is
  deferred to v0.2.
- **T04 React major upgrades are scheduled work:** Host-config churn across
  React major versions is accepted as a one-off migration every ~12–18
  months, landed in a single PR with a pinned version bump.
- **T05 Web renderer is not API-stable:** The companion web renderer exists
  for preview/Storybook only. Its output DOM, CSS hooks, and component
  props may change without deprecation.
- **T06 Archive-on-partial-failure:** Per A09, mid-flight sub-page creation
  that fails after `pages.create` leaves an archived orphan rather than
  attempting a speculative block-level cleanup. The next sync reconciles
  by id — the orphan is either rehydrated (if JSX still contains the
  `<ChildPage>`) or stays archived. Acceptable because archived pages are
  trash-recoverable and the alternative (block-by-block rollback) is not
  transactional anyway.
- **T07 No cross-page op batching:** Block ops are batched up to 100
  children per `NotionBlocks.append` call; page ops (`createPage`,
  `updatePage`, `archivePage`) are always individual requests. Sub-page
  boundaries cut batch windows. Acceptable because page ops are rare
  relative to block ops and the simplicity of per-page scopes outweighs
  small request-count wins.
- **T08 Same-parent `<ChildPage>` creates are sequential:** `pages.create`
  under the same parent is issued one request at a time (not in parallel)
  so the resulting `child_page` block order on the parent matches JSX
  order. Empirical probe: parallel `pages.create` under the same parent
  yields a nondeterministic `child_page` ordering on the parent; sequential
  POSTs preserve order 1:1. The latency cost (N sibling creates ≈ N
  round-trips) is accepted to make JSX order authoritative without a
  post-create re-fetch.
- **T09 Database-parented pages deferred:** v0.1 of page ops targets
  page-parented sub-pages. Database parents, custom property schemas, and
  `is_locked`/`erase_content` surfaces are explicitly out of scope but
  must not be precluded by the prop design.

## Requirements

### Must render Notion pages from JSX

- **R01 1:1 block fidelity:** Every non-deprecated Notion block type must
  be expressible either through a dedicated block component or through the
  `<Raw>` escape hatch. Rendering the library's components must produce a
  Notion payload structurally equivalent to what a hand-written
  `NotionBlocks.append` call would send for the same content.
- **R02 Rich text via composition:** Inline components (`<Bold>`,
  `<Italic>`, `<Link>`, `<Mention>`, `<InlineEquation>`, `<Color>`, …) must
  compose annotations and links into a single Notion `rich_text[]` array
  per block, with annotation merges semantically equivalent to the Notion
  UI's annotation behaviour.
- **R03 Component reuse:** Downstream callers must be able to build
  higher-level components that encapsulate block subtrees, hooks, and
  context. Custom components must not need access to reconciler internals
  to compose existing block components.

### Must sync op-minimally

- **R04 Idempotent resync:** Re-rendering the identical JSX tree against
  the same cache must emit zero Notion API mutations.
- **R05 Single-prop change → single update:** A change to exactly one
  block's projected payload must produce exactly one `update` op.
- **R06 Single sibling insert/remove → single op:** A single sibling
  addition produces one `append` or `insert`; a single sibling removal
  produces one `remove`. No collateral reorders when neighbors are stable.
- **R07 Keyed identity:** Block identity across renders must be derivable
  from an explicit `blockKey`-style hint. In its absence, siblings fall
  back to positional keys per T02.

### Must be Effect-native

- **R08 Effect return type:** The public sync entrypoints must return
  `Effect<SyncResult, NotionSyncError, NotionConfig | HttpClient>`. Errors
  are tagged; there are no thrown exceptions on the happy path or on
  known-bad Notion responses.
- **R09 No ambient state:** The library must not read global singletons
  (no module-level HTTP clients, no ambient config). All dependencies flow
  through the Effect environment or explicit function arguments.

### Must have a pluggable cache

- **R10 Cache interface:** The reconciler state is persisted through a
  single `NotionCache` interface that exposes `load` and `save` returning
  Effects with a typed `CacheError`.
- **R11 Filesystem + in-memory cache shipped:** At minimum, the library
  ships an `FsCache` (JSON file, atomic rename) and an `InMemoryCache`.
- **R12 Third-party cache backends:** SQLite or other backends can be
  authored downstream without forking the library by implementing
  `NotionCache`.
- **R13 Schema version gate:** Cache payloads carry a schema version.
  Mismatches are handled by the sync driver — either by falling back to a
  cold path or by transparently returning `undefined` from `load` — not by
  silent data corruption.

### Must handle async uploads

- **R14 Pre-resolve path (v0.1):** Callers may pre-resolve uploads and
  expose them through an `UploadRegistry` context; components read from
  the registry synchronously during render.
- **R15 Suspense path (v0.2):** The architecture must admit, without a
  redesign, a Suspense-backed variant where components can `use()` an
  upload promise during render.

### Must have principled fallbacks

- **R16 Fallback triggers enumerated:** The sync driver must define and
  document the exhaustive set of conditions that force a fallback (full
  rebuild): cache miss, schema mismatch, page-id drift, missing/archived
  block referenced by cache, structural drift beyond diff's capability.
- **R17 Fallback is append-only-safe:** The fallback path must not rely
  on the Notion `move` API and must leave the page in a valid state even
  if interrupted mid-flight (no dangling half-trees).
- **R18 Fallback reason is reported:** `SyncResult` must carry the
  fallback reason when a fallback is used, so callers can log/observe it.

### Must be testable end-to-end

- **R19 Integration test per block type:** Every shipped block component
  must have at least one integration test that renders through the real
  reconciler against a Notion-shaped fixture and verifies the emitted
  payload.
- **R20 Mutation-scenario suite:** The core mutation scenarios (insert,
  remove, update, reorder, nested change) must be covered by a suite that
  asserts op-counts meet R04–R06.
- **R21 Web renderer for visual iteration:** A companion web renderer
  must let component authors render their JSX tree into a Notion-looking
  HTML preview inside Storybook. It is a development aid, not a
  production target (per T05).
- **R21a Page-op scenario suite:** Page-level mutations (root metadata
  change, sub-page create, sub-page rename, sub-page icon/cover change,
  sub-page archive, sub-page reparent via `move`, partial-failure archive
  &amp; resync) must each be covered by an e2e test that asserts API
  op-counts meet R24–R28. Cache v2→v3 migration, >100 children under a
  newly created sub-page, and inline-depth-3 subtree splitting must also
  be covered.

### Must reconcile page-level metadata and sub-pages

- **R24 Root page metadata projection:** `<Page>` props (`title`, `icon`,
  `cover`) must project to `NotionPages.update` on the sync root (the
  `pageId` passed to `sync`). No-op when unchanged; single `pages.update`
  call when any field changes; per A07 the stored cache compares against
  the response-normalized shape.
- **R25 JSX-driven sub-pages:** `<ChildPage>` with `title`, `icon`,
  `cover`, and JSX `children` must create, update, archive, and populate
  the referenced page via `NotionPages.create` / `NotionPages.update`
  / (archive =) `NotionPages.update {in_trash:true}`. Title / icon / cover
  changes must never route through the block API (per A06).
- **R26 Per-page sync boundary:** Each rendered page (the root and every
  nested `<ChildPage>`) is its own reconciliation unit with an isolated
  `blockKey` namespace and its own cache subtree. Block ops for a page
  only touch that page's children.
- **R27 Sub-page ordering via `pages.move`:** When the driver detects a
  `<ChildPage>` retained across renders but reparented, it must use
  `NotionPages.move` to preserve the id, not archive + recreate. Siblings
  reordering within the same parent may remain remove+re-insert if the
  block-level ordering algorithm cannot be adapted to pages cheaply
  (documented, not silent).
- **R28 Partial-failure archive & reconcile:** If a `pages.create` succeeds
  but subsequent child ops fail, the driver must archive the orphan via
  `in_trash:true` before surfacing the error. The next `sync()` with the
  same JSX reconciles by re-creating from scratch — archived orphans stay
  archived.
- **R29 SyncResult exposes page op counts:** `SyncResult` must carry
  `pages: { creates, updates, archives, moves }` alongside existing block
  counts. `SyncEvent` gains `PageOpIssued` / `PageOpApplied` variants.
- **R30 Cache migration is transparent:** Bumping `CACHE_SCHEMA_VERSION`
  for this feature (2 → 3, adding `nodeKind` and per-page subtrees) must
  fall through the existing `"schema-mismatch"` path — callers must not
  see hard errors on existing caches. A new fallback reason `"page-missing"`
  covers the case where a cached page id is archived or deleted out of
  band; `"page-archived"` differentiates drift from intentional archival.

### Must bound churn from upstream

- **R22 Pinned react / react-reconciler:** Both are exact-pinned. Upgrades
  are gated behind an explicit version bump per A03 / T04.
- **R23 Host-config encapsulation:** All react-reconciler host-config
  details live behind an internal module boundary; downstream callers
  must never need to touch it.
