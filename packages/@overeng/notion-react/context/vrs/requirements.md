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

### Must bound churn from upstream

- **R22 Pinned react / react-reconciler:** Both are exact-pinned. Upgrades
  are gated behind an explicit version bump per A03 / T04.
- **R23 Host-config encapsulation:** All react-reconciler host-config
  details live behind an internal module boundary; downstream callers
  must never need to touch it.
