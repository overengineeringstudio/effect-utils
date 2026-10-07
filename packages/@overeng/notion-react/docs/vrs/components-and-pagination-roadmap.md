# Component and Pagination Roadmap

This proposal scopes two renderer follow-ups: replacing the three named Raw
passthrough wrappers with modeled components, and turning the pagination test
file's stale `XXX`/#95 language into an explicit, finite boundary-test plan.
It is a proposal, not a claim that readback/adoption can already verify these
opaque block types.

## First-class block components

`src/components/blocks.ts:191-205` defines `Raw` and `Template`,
`LinkPreview`, and `SyncedBlock` as `unknown`-payload passthroughs. The host
fallback forwards their payload verbatim (`src/renderer/host-config.ts:232-237`),
while generic readback explicitly rejects them because the response shape is not
normalizable (`src/renderer/readback.ts:48-56`). The implementation should
replace only the three named wrappers; preserve `<Raw>` as an escape hatch for
other or not-yet-modeled block types.

### Proposed API shapes

- **`<Template title="…" />`**: model the template's user-authored title as a
  string, with Notion's request payload constructed internally. It has no
  renderable block children. Confirm the exact create/update payload against
  the pinned Notion API type before implementation; do not carry an arbitrary
  `content` object through the public API.
- **`<LinkPreview url="…" />`**: Notion's API exposes `link_preview` in
  responses only; it cannot be created through the write API. Treat this as a
  read-only/preserve-only representation of an already existing block, not as a
  candidate block that the renderer can append or update. The read-side model
  may expose a typed URL, but must not claim write support
  (Notion API: [Link preview](https://developers.notion.com/reference/block#link-preview)).
  Keep this component out of request-payload projection tests.
- **`<SyncedBlock source={...}>…</SyncedBlock>`**: distinguish an original
  synced block from a reference to an existing source in the API. A source
  block may own children; a reference must not accidentally claim copied
  children as renderer-owned content. Model the two modes as a discriminated
  API (e.g. original vs reference) with source identity typed as a Notion block
  id. Final names and payload details are a design decision after checking the
  pinned API schema and existing `src/web/demo/modern-synced-block.stories.tsx`
  examples; avoid an overloaded `unknown` or `content` prop.

For each component, use a dedicated props type in `src/components/props.ts`,
project through the normal block props path, and mirror the public shape in
`src/web/blocks.tsx`. Keep the DOM/web mirror behavior useful for inspecting the
modeled fields. Add request-shape tests for Template/SyncedBlock and response-
shape tests for read-only LinkPreview. Add compile-time tests for invalid
mode/prop combinations. Update API/cookbook tables and
remove the obsolete passthrough-wrapper wording for these three only. Keep
`Raw`, `ChildDatabase`, and `Breadcrumb` unchanged in this scope.

**Readback boundary:** first-class request props alone do not make provider
responses verifiable. LinkPreview must have a response-side, read/preserve-only
representation and must never enter a create/update request. Until a
block-specific readback normalizer and its semantics exist, LinkPreview,
Template, and SyncedBlock remain unsupported for adoption/readback, preserving
the fail-closed contract (`src/renderer/adopt.ts:131-135`,
`src/renderer/readback.ts:48-56`). In particular, do not infer or delete
source-owned synced-block children.

### Component acceptance cases

1. Template title projects to the exact type-tagged request payload; absent or
   invalid title follows the Notion schema's actual rules.
2. LinkPreview models an API response without producing a create/update
   request; existing link-preview data is not lost by a read/preserve path, and
   write attempts are explicitly unsupported.
3. Synced-block original and reference modes produce distinct, schema-valid
   payloads; child ownership is explicit and reference children cannot be
   mistaken for locally managed descendants.
4. Template and SyncedBlock project through the reconciler as applicable;
   LinkPreview is read/preserve-only; Raw still supports arbitrary extension
   blocks.
5. Until block-specific response normalization exists, readback/adoption refuse
   these nodes rather than reporting verified equality, including LinkPreview
   even when its response-side read/preserve representation exists.

## Pagination and API-boundary cases

`src/renderer/pagination.unit.test.tsx:16-23` says each unimplemented API
boundary is marked `XXX`/#95, but no such per-case markers exist in the suite;
`#95` is also the generic tracking label used by the skipped performance test
at lines 306-308. Existing tests already cover many correctness boundaries.
Keep those tests as regression cases and replace the broad comment with an
inventory that distinguishes implemented cases from genuinely open work.

### Already covered (retain, not backlog)

1. Rich-text segment cap: 2,500 characters become 2,000 + 500, content
   preserved (`pagination.unit.test.tsx:38-53`; detailed annotation/link and
   surrogate-pair boundaries are in `flatten-rich-text.unit.test.tsx:164-218`).
2. Top-level append cap: 150 siblings are sent as batches of 100 + 50
   (`pagination.unit.test.tsx:55-76`).
3. Append-run boundaries: an intervening update flushes separate append runs
   (`pagination.unit.test.tsx:78-141`); multiple parents are independently
   batched (`:142-184`).
4. Empty containers, partial-batch checkpointing, idempotent resync, and
   retry-only-missing-tail are covered (`pagination.unit.test.tsx:185-304`).

### Open cases to add or explicitly close

1. **Nested create payload cap:** a table/column container whose immediate
   inlined children hit exactly 100 and then 101; assert no physical nested
   request exceeds 100, overflow is emitted only after the parent id exists,
   and final child order is unchanged. Cover at least one nested level and the
   code path documented in `sync.ts:275-279,589-594`.
2. **Read pagination continuation:** fake a children-list response with multiple
   pages and assert all cursors are followed exactly once, in order, until
   `has_more=false`; include an empty intermediate page with a continuation
   cursor and a final empty page. This tests retrieval pagination rather than
   append batching (`sync.ts:1085-1105`).
3. **Large tree / bounded request behavior:** generate a large multi-parent tree
   with mixed append and insert operations; assert per-parent request cap,
   operation order, and that no request exceeds Notion's limit. This should be a
   deterministic functional test, not a wall-clock assertion.
4. **Failure at a page boundary:** fail the second paginated read and verify the
   error is surfaced without committing an incomplete observed tree or
   checkpoint; retry must complete from authoritative state. Add only if the
   current fake can observe the atomicity boundary.
5. **Large-page performance target:** replace the skipped test at
   `pagination.unit.test.tsx:306-308` only after a benchmark harness specifies
   representative page shape, warmup/repetition, measurement boundary, and
   stable budget. The existing 2x flush-time target is not executable as a unit
   test and must not be made a flaky CI timing assertion.

For every added case, state whether it is an API contract, a sync-driver
invariant, or a performance objective. Do not label already-covered behavior
as an `XXX`; link open work to a real tracking issue only after its identity is
confirmed (the `#95` reference is ambiguous in this repository context).
