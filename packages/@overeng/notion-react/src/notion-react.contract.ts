/**
 * SEAM member contract for the `notion-react.*` telemetry namespace (decision 0005) —
 * notion-react's OWN observability catalog, authored via the Layer-2
 * `@overeng/otel-contract/registry` surface. This is the single home for the two o11y adapters'
 * telemetry attribute catalog: the Weaver registry projection AND the runtime encoders
 * (`src/o11y/effect-adapter.ts`, `src/o11y/otel-adapter.ts`) both derive from it (SC-R13/R14).
 *
 * This is a `*.contract.ts` seam file, so it is exempt from the `otel-contract-in-seam-file` lint
 * and MUST be registered in the root aggregator's `memberSeamPaths` (a colocated no-orphan-seam
 * test asserts this).
 *
 * NAMESPACE `notion-react` (HYPHENATED). This is the existing wire namespace: every emitted key is
 * already `notion-react.*` (see the two adapters). It is preserved VERBATIM (behavior-preserving —
 * no rename). `weaver registry check --future` accepts the hyphenated segment (empirically probed,
 * mirroring the `pw.*` camelCase precedent). NOTE the caveat FLAGGED in the migration report: that
 * gate is non-discriminating on attribute-name shape (an invalid uppercase key also passes), so
 * "weaver accepts" here means "no gate in the pipeline enforces segment naming" — identical to how
 * the `pw.*` camelCase keys shipped. This namespace is disjoint from `notion` / `notion_md`.
 *
 * RAW-TRACER SPANS, NOT `OtelOperation`. Both adapters mint spans directly via the tracer API
 * (`Tracer.span` / `@opentelemetry/api` `startSpan`) and attach attributes from standalone
 * `OtelAttrs.defineSync` bundles at distinct lifecycle points (SyncStart / SyncEnd / per-op /
 * span-events). There is no `OtelOperation`/`OtelSpan` encoder to re-point; instead each adapter
 * bundle is REBUILT from the SAME `attr.*` catalog schemas exported here (byte-identical encode,
 * proven by the colocated equivalence property test). The one static-name span
 * (`notion-react.sync`) is projected as a registry span signal; the dynamic-name per-op span
 * (`notion-react.op.<kind>`, name embeds the kind) and the span-event bundles reach the catalog
 * via `docOnlyAttributes` (SC-DQ5 / SC-R13 completeness).
 *
 * EXCLUDED runtime-only fields: `service.name` (a RESOURCE attribute — firstSeg `service` ≠
 * `notion-react`, so routing it through the catalog would trip `WeaverStrayNamespaceKeyError`) and
 * `span.label` both stay plain inline `OtelAttr.*` fields in the adapter bundles, absent from the
 * registry projection (SC-T03).
 */
import {
  attr,
  defineOtelContract,
  recommended,
  required,
  span,
} from '@overeng/otel-contract/registry'

// ---------------------------------------------------------------------------
// attributes (annotated Effect Schemas; the notion-react.* catalog SSOT)
// ---------------------------------------------------------------------------

// -- sync root span --
/** Notion page id a sync targets. */
export const NotionReactPageId = attr.string({
  key: 'notion-react.page_id',
  cardinality: 'high',
  brief: 'Notion page id a sync targets.',
  stability: 'development',
  examples: ['205d5c1a-0000-4000-8000-000000000000'],
})

/** Number of root blocks in the synced document tree. */
export const NotionReactRootBlockCount = attr.number({
  key: 'notion-react.root_block_count',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of root blocks in the synced document tree.',
  stability: 'development',
  examples: [1, 42],
})

/** Whether the sync completed successfully. */
export const NotionReactOk = attr.boolean({
  key: 'notion-react.ok',
  brief: 'Whether the sync completed successfully.',
  stability: 'development',
})

/** Number of HTTP ops issued during the sync. */
export const NotionReactOpCount = attr.number({
  key: 'notion-react.op_count',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of HTTP ops issued during the sync.',
  stability: 'development',
  examples: [0, 12],
})

/** Wall-clock duration of the whole sync in milliseconds. */
export const NotionReactDurationMs = attr.number({
  key: 'notion-react.duration_ms',
  weaverType: 'double',
  cardinality: 'high',
  brief: 'Wall-clock duration of the whole sync in milliseconds.',
  stability: 'development',
  examples: [12.5, 1500],
})

/** Reason the sync fell back to a full re-render (freeform). */
export const NotionReactFallbackReason = attr.string({
  key: 'notion-react.fallback_reason',
  cardinality: 'high',
  brief: 'Reason the sync fell back to a full re-render.',
  stability: 'development',
  examples: ['checkpoint-missing', 'hash-mismatch'],
})

// -- per-op span (dynamic-name bridge `notion-react.op.<kind>`) --
/** Correlation id of one HTTP op within a sync (`OpIssued.id`). */
export const NotionReactOpId = attr.number({
  key: 'notion-react.op.id',
  weaverType: 'int',
  cardinality: 'high',
  brief: 'Correlation id of one HTTP op within a sync.',
  stability: 'development',
  examples: [0, 7],
})

/** Kind of Notion HTTP op a span wraps. */
export const NotionReactOpKind = attr.enum({
  key: 'notion-react.op.kind',
  values: ['append', 'update', 'delete', 'retrieve'],
  briefs: {
    append: 'Append blocks.',
    update: 'Update a block.',
    delete: 'Delete (archive) a block.',
    retrieve: 'Retrieve blocks.',
  },
  brief: 'Kind of Notion HTTP op a span wraps.',
  stability: 'development',
})

/** Wall-clock duration of one op in milliseconds. */
export const NotionReactOpDurationMs = attr.number({
  key: 'notion-react.op.duration_ms',
  weaverType: 'double',
  cardinality: 'high',
  brief: 'Wall-clock duration of one op in milliseconds.',
  stability: 'development',
  examples: [1.5, 250],
})

/** Number of results returned by one op. */
export const NotionReactOpResultCount = attr.number({
  key: 'notion-react.op.result_count',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of results returned by one op.',
  stability: 'development',
  examples: [0, 3],
})

/** Note recorded on a succeeded op. */
export const NotionReactOpNote = attr.enum({
  key: 'notion-react.op.note',
  values: ['already-archived'],
  briefs: {
    'already-archived': 'The target block was already archived (delete no-op).',
  },
  brief: 'Note recorded on a succeeded op.',
  stability: 'development',
})

/** Error message recorded on a failed op (freeform). */
export const NotionReactOpError = attr.string({
  key: 'notion-react.op.error',
  cardinality: 'high',
  brief: 'Error message recorded on a failed op.',
  stability: 'development',
  examples: ['validation_error: body.length'],
})

// -- batch-flush span event --
/** Number of ops issued into a flushed batch. */
export const NotionReactBatchIssued = attr.number({
  key: 'notion-react.batch.issued',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of ops issued into a flushed batch.',
  stability: 'development',
  examples: [0, 25],
})

/** Number of ops actually batched in a flush. */
export const NotionReactBatchBatched = attr.number({
  key: 'notion-react.batch.batched',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of ops actually batched in a flush.',
  stability: 'development',
  examples: [0, 25],
})

// -- update-noop span event --
/** Block id of an update that was a no-op. */
export const NotionReactBlockId = attr.string({
  key: 'notion-react.block_id',
  cardinality: 'high',
  brief: 'Block id of an update that was a no-op.',
  stability: 'development',
  examples: ['205d5c1a-0000-4000-8000-000000000000'],
})

/** Reason an update was a no-op. */
export const NotionReactNoopReason = attr.enum({
  key: 'notion-react.noop_reason',
  values: ['hash-equal', 'other'],
  briefs: {
    'hash-equal': 'The block hash was unchanged.',
    other: 'Another (unclassified) no-op reason.',
  },
  brief: 'Reason an update was a no-op.',
  stability: 'development',
})

// -- checkpoint-written span event --
/** Size of a written checkpoint in bytes. */
export const NotionReactCheckpointBytes = attr.number({
  key: 'notion-react.checkpoint.bytes',
  weaverType: 'int',
  cardinality: 'high',
  brief: 'Size of a written checkpoint in bytes.',
  stability: 'development',
  examples: [512, 40960],
})

// ---------------------------------------------------------------------------
// signal (the ONE static-name span; per-op + span-events land via docOnlyAttributes)
// ---------------------------------------------------------------------------

/**
 * `notion-react.sync` — the root span per sync invocation. Its attributes are attached across the
 * SyncStart (`page_id`, `root_block_count`) and SyncEnd (`ok`, `op_count`, `duration_ms`,
 * optional `fallback_reason`) lifecycle points; the runtime keeps its two `OtelAttrs.defineSync`
 * bundles (rebuilt from the schemas above), so this signal is the REGISTRY projection only.
 */
export const NotionReactSyncSpan = span({
  id: 'span.notion-react.sync',
  kind: 'internal',
  brief: 'The root span per notion-react sync invocation.',
  stability: 'development',
  attributes: {
    pageId: required(NotionReactPageId),
    rootBlockCount: required(NotionReactRootBlockCount),
    ok: required(NotionReactOk),
    opCount: required(NotionReactOpCount),
    durationMs: required(NotionReactDurationMs),
    fallbackReason: recommended(NotionReactFallbackReason),
  },
})

// ---------------------------------------------------------------------------
// contract seam (namespace `notion-react`, derived).
// ---------------------------------------------------------------------------

export default defineOtelContract({
  memberPath: 'packages/@overeng/notion-react',
  displayName: 'Notion React Attributes',
  signals: [NotionReactSyncSpan],
  // Keys reaching the catalog ONLY via the DYNAMIC-NAME `notion-react.op.<kind>` bridge span or a
  // span-event bundle (no static single-signal open-ref carries them). Catalog completeness
  // (SC-R13). `notion-react.sync`'s six attrs ride the span signal above and are NOT repeated here.
  docOnlyAttributes: [
    // dynamic-name bridge: `notion-react.op.<kind>` (per-op span) + OpSucceeded/OpFailed bundles
    NotionReactOpId,
    NotionReactOpKind,
    NotionReactOpDurationMs,
    NotionReactOpResultCount,
    NotionReactOpNote,
    NotionReactOpError,
    // span event: batch-flush
    NotionReactBatchIssued,
    NotionReactBatchBatched,
    // span event: update-noop
    NotionReactBlockId,
    NotionReactNoopReason,
    // span event: checkpoint-written
    NotionReactCheckpointBytes,
  ],
})
