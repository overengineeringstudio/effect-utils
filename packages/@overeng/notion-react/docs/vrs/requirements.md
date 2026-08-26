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
  key or client token. A successful `pages.create` is therefore an
  irreversible identity allocation: recovery depends on durably correlating
  JSX identity to the returned page id before any subsequent remote read or
  mutation. Archived pages remain retrievable via `pages.retrieve` /
  `blocks.retrieve`; only `blocks.children.list` returns 404 on an archived
  page.
- **A10 Title length:** Each title rich_text span is capped at 2000
  characters. Callers that need longer titles must split across spans.
- **A11 Offline fidelity reference:** Notion's own enhanced-Markdown endpoint
  output is not available without network access. Projection fidelity is
  therefore measured against JSX component semantics and the workspace's
  de-facto enhanced-Markdown dialect (the pull-side renderer and canonicalizer
  in `@overeng/notion-effect-client`), not against Notion endpoint output.
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
- **T06 Additional create checkpoint:** Per A09, sub-page creation performs an
  extra cache save immediately after `pages.create`, before retrieving inline
  descendants. This additional write is accepted because preserving the
  server-minted page identity across process death is more important than
  minimizing local cache writes.
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
- **T10 Two Markdown spelling tables:** The read-only projection owns its
  block→Markdown spellings separately from the pull-side wire renderer.
  Drift between them is accepted until a second consumer justifies
  centralization (#1098); golden tests pin the projection dialect in the
  meantime.
- **T11 A plan can go stale (TOCTOU):** There is no lock between a
  `plan()` and a later `sync()`; a concurrent writer can invalidate the
  plan in between. This is accepted because `sync()` recomputes from
  scratch — the _plan_ is what goes stale, never the applied result.
  Callers gating on a plan (pre-apply audit) must treat it as advisory
  for the observed instant, and use the post-apply empty-plan fixpoint
  check for proof.
- **T12 Readback equality is scoped, not total:** The readback oracle
  certifies managed content only. Deliberately outside its equality:
  uploaded-asset bytes (signed URLs expire; masked to an `uploaded`
  sentinel), built-in icon identity behind Notion's undocumented
  `{type:'icon'}` rewrite (masked to `builtin-unverified`),
  provider-owned defaults the JSX never claimed, and sub-page content
  behind a `child_page` boundary (title-only identity; the sub-page gets
  its own readback pass). A readback-equal page can therefore differ in
  those masked dimensions — accepted, because the alternative is a
  comparison that flaps on server-owned noise. Like T11, an observation
  has no snapshot isolation: equality is advisory for the observed
  window.

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
  back to positional keys per T02. The key encoding is public contract:
  consumers that construct or index into a `CacheTree` out-of-band must
  be able to derive the exact node keys through an exported encoder, and
  the internal derivation must route through that same encoder so the two
  cannot drift.

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
  sub-page archive, sub-page reparent via `move`, interrupted-create adoption
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
  `NotionPages.move` to preserve the id, not archive + recreate.
  Intra-parent sibling reorder is supported behind the opt-in
  `reorderSiblings` option (phase 4d, #618): the driver emits a single
  `reorderPages` op and realizes it via 2N `pages.move` roundtrips
  through a holding parent. Default stays off — unretained
  same-parent-reshuffle siblings still flow through `movePage` and the
  API rejection is swallowed, matching the pre-phase-4d contract.
- **R28 Interrupted-create identity recovery:** After `pages.create`
  succeeds, the driver must durably save the returned page id and immutable
  create-time inline descriptors before any operation that can fail. A retry
  with the same keyed `<ChildPage>` must adopt that page and its inline
  descendants without another page create or duplicated body. If current JSX
  changed after interruption, the retry must first adopt the create-time live
  state and then reconcile the current candidate normally.
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

### Must expose a read-only plan

- **R37 Plan/sync parity:** `plan()` must compute the exact op sequence
  `sync()` would apply for the same element and observed state — through
  the same pre-flight and diff code path (shared helpers, not a
  reimplementation), including the root-page metadata update `sync()`
  applies outside its internal diff — while performing no write: no
  Notion mutation and no cache save. An empty plan is the fixpoint
  oracle: immediately after a successful `sync()` of the same element,
  `plan()` must return zero ops.
- **R38 Plan staleness is explicit:** The default `'live'` staleness
  mirrors sync's shallow pre-flight with read-only calls and detects
  out-of-band top-level drift; `'cache-only'` issues zero requests and
  is a pure function of cache + JSX. The blind spots of `'cache-only'`
  (out-of-band drift, cold-`'clean'` baseline removes, pending-marker
  resolution) must be documented, not silently approximated.

### Must verify server state against intent

- **R39 Readback oracle in a dedicated hash space:** The library must
  offer a normalization oracle that folds server-observed block JSON and
  rendered candidate trees into one canonical form and compares them by
  hash, absorbing every response-shape delta the API introduces
  (decorated/re-segmented rich text, explicit defaults, provider-injected
  fields, A07 envelope rewrites). Readback hashes are a separate hash
  space from `CacheNode.hash` (which hashes request-shape projected
  props); the two must never be compared against each other, and the
  cache hash function must not change to accommodate readback — doing so
  would invalidate every deployed cache.
- **R40 Masking is candidate-contextual:** Whether an observed field is
  managed content or provider-owned noise depends on whether the JSX
  claimed it (e.g. an unclaimed callout icon is server-injected; a claimed
  one is exact content). The comparison must therefore take both sides —
  a context-free "hash of observed blocks" cannot exist in the public
  API. Fields that are unverifiable through block JSON in principle
  (uploaded-asset signed URLs, built-in-icon name↔URL mapping) must be
  masked explicitly and documented, never compared best-effort.

### Must guarantee page survival on demand

- **R41 Append-only page lifecycle:** With `pageLifecycle: 'append-only'`
  on `sync()`/`plan()`, the library must guarantee it never archives,
  moves, or reorders a page and never creates one out of tail position in
  its parent's page-sibling run — enforced by a single pure predicate
  over the computed plan, evaluated immediately after `diff()` and before
  any op applies. A violation fails the WHOLE sync (fail, not skip —
  dropping ops would silently diverge server from cache) with
  `NotionSyncError { reason: 'page-lifecycle-violation' }` carrying the
  offending `DiffOp[]`. Block ops and page content (`updatePage`
  title/icon/cover) remain fully managed; `plan()` reports the same
  violations without failing; #1100 pending-adoption (read + cache-save)
  remains legal under the mode.

### Must project authored JSX to readable Markdown (experimental)

- **R31 Read-only offline projection:** Rendering JSX through the Markdown
  entry point must produce a body with no network access, no Notion
  mutations, and no cache reads or writes.
- **R32 Shared render semantics:** The projection must consume the same
  normalized candidate-tree representation that feeds Notion projection —
  never by scraping rendered HTML and never by reconstructing content from
  mutation operations.
- **R33 No silent loss:** Every construct that cannot be represented
  losslessly must either appear in a documented spelling or produce a typed
  diagnostic. Unsupported or lossy constructs must not disappear silently,
  and the body must always be produced (no fail-closed refusal).
- **R34 Deterministic output:** Identical JSX must produce byte-identical
  bodies — LF line endings, stable ordering, no ambient state — suitable
  for reviewed snapshots and diffs.
- **R35 Envelope composition without reverse coupling:** The returned body
  must compose with `@overeng/notion-md`'s `renderNmdFile`; production code
  in this package must not depend on `@overeng/notion-md`, and
  `@overeng/notion-md` must not depend on this package.
- **R36 Experimental contract is documented:** Until promoted stable, docs
  must mark the entry point experimental and distinguish projection
  fidelity from production reconciliation fidelity and Notion endpoint
  round-trip fidelity; Markdown equality must not be interpretable as
  CacheTree identity or sync safety.
