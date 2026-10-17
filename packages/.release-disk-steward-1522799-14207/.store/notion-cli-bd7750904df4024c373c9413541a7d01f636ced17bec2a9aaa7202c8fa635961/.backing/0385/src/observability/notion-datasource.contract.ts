/**
 * SEAM member contract for the `notion_datasource.*` telemetry namespace (decision 0005) —
 * notion-datasource-sync's OWN observability catalog, authored via the Layer-2
 * `@overeng/otel-contract/registry` surface. This is the single home for the package's telemetry
 * attribute-key catalog + the request counter: the Weaver registry projection AND the runtime
 * encoders (`./observability.ts`) both derive from it (SC-R13/R14).
 *
 * This is a `*.contract.ts` seam file, so it is exempt from the `otel-contract-in-seam-file` lint
 * and MUST be registered in the root aggregator's `memberSeamPaths` (a colocated no-orphan-seam
 * test asserts this).
 *
 * NAMESPACE `notion_datasource` (mirroring notion-md's `notion_md`). The package's keys were
 * historically `notion.datasource.*`, which DERIVE the first-party `notion` namespace and COLLIDE
 * with notion-effect-client's `notion` catalog. This migration RENAMES every key to a disjoint
 * `notion_datasource.*` namespace — a BREAKING wire rename (approved): the old `notion.datasource.*`
 * keys stop being emitted, the new `notion_datasource.*` keys emit.
 *
 * SHARED-BAG SPANS → docOnly, NOT operation signals. Every traced span in this package shares ONE
 * big optional attribute bag (`observability.ts`'s `SpanAttributesSchema`) and is labelled by a
 * computed `span.label`; no span carries a stable per-signal attribute projection. Forcing them into
 * `operation()` signals would either produce empty groups (Weaver rejects) or ~19 identical bags
 * (misrepresenting the runtime), so — like restate's dynamic bridges — every catalog key reaches the
 * registry via `docOnlyAttributes` (SC-R13 completeness) and `signals` stays empty. The spans stay
 * runtime-inline in `observability.ts`, rebuilt from the seam-owned key strings ({@link spanAttrKeys}).
 *
 * METRIC stays RAW (not a `metric()` signal), mirroring notion-effect-client: the request counter
 * has NO unit, which the registry `metric()` DSL cannot express (it requires a `unit`). Its single
 * label key (`notion_datasource.operation`) is namespaced already and reaches the catalog via
 * `docOnlyAttributes`.
 *
 * FOREIGN / RUNTIME-ONLY keys excluded from the catalog: `agent.iteration.id` (an `agent`-namespace
 * correlation key — NOT a `notion_datasource` own key; it resolves in no member/upstream registry,
 * so `refExternal` would dangle and `docOnly` would break namespace derivation — it stays a
 * runtime-only annotate bundle) and `span.label` (the runtime-only label source, filtered from every
 * registry projection).
 */
import { Schema } from 'effect'

import { OtelAttr, OtelMetric } from '@overeng/otel-contract'
import { attr, defineOtelContract } from '@overeng/otel-contract/registry'

// ---------------------------------------------------------------------------
// spanAttrKeys — the SSOT for every attribute key string (camelCase field → emitted wire key).
// `observability.ts` re-exports this as `spanAttr` and rebuilds its runtime encoders from it, so
// the rename lives in exactly ONE place. `agentIterationId` (foreign) + `spanLabel` (runtime-only)
// are present here for the runtime encoder but are NOT catalogued below.
// ---------------------------------------------------------------------------

/** Camel-cased field → emitted OTel attribute key. Single source for the `notion_datasource.*` keys. */
export const spanAttrKeys = {
  agentIterationId: 'agent.iteration.id',
  apiVersion: 'notion_datasource.api_version',
  appendedEvents: 'notion_datasource.appended_events',
  attempt: 'notion_datasource.attempt',
  blockedCount: 'notion_datasource.blocked_count',
  bodyCompleteness: 'notion_datasource.body.completeness',
  bodyEvidenceDigest: 'notion_datasource.body.evidence.digest',
  bodyIdentityDigest: 'notion_datasource.body.identity.digest',
  bodyIdentityKind: 'notion_datasource.body.identity.kind',
  bodyRenderedDigest: 'notion_datasource.body.rendered.digest',
  cancelled: 'notion_datasource.cancelled',
  cappedAtLimit: 'notion_datasource.capped_at_limit',
  command: 'notion_datasource.command',
  commandId: 'notion_datasource.command_id',
  commandKind: 'notion_datasource.command_kind',
  completedCycles: 'notion_datasource.completed_cycles',
  conflictCount: 'notion_datasource.conflict_count',
  cycle: 'notion_datasource.cycle',
  cycles: 'notion_datasource.cycles',
  dataSourceId: 'notion_datasource.data_source_id',
  dryRun: 'notion_datasource.dry_run',
  enqueuedCommands: 'notion_datasource.enqueued_commands',
  eventCount: 'notion_datasource.event_count',
  executorSteps: 'notion_datasource.executor_steps',
  guard: 'notion_datasource.guard',
  incompletePropertyCount: 'notion_datasource.incomplete_property_count',
  leaseDurationMs: 'notion_datasource.lease_duration_ms',
  localObservationCount: 'notion_datasource.local_observation_count',
  maxCycles: 'notion_datasource.max_cycles',
  maxExecutorSteps: 'notion_datasource.max_executor_steps',
  maxStepsReached: 'notion_datasource.max_steps_reached',
  mode: 'notion_datasource.mode',
  operation: 'notion_datasource.operation',
  outboxAmbiguousCount: 'notion_datasource.outbox_ambiguous_count',
  outboxBlockedCount: 'notion_datasource.outbox_blocked_count',
  outboxQueuedCount: 'notion_datasource.outbox_queued_count',
  outboxRetryableCount: 'notion_datasource.outbox_retryable_count',
  outboxRunningCount: 'notion_datasource.outbox_running_count',
  pageId: 'notion_datasource.page_id',
  processRole: 'notion_datasource.process.role',
  propertyId: 'notion_datasource.property_id',
  queryComplete: 'notion_datasource.query_complete',
  queryPageCount: 'notion_datasource.query_page_count',
  result: 'notion_datasource.result',
  rootId: 'notion_datasource.root_id',
  rowCount: 'notion_datasource.row_count',
  settlementKind: 'notion_datasource.settlement_kind',
  spanLabel: 'span.label',
  statusState: 'notion_datasource.status.state',
  wakeSource: 'notion_datasource.wake_source',
  webhookEventType: 'notion_datasource.webhook.event_type',
  webhookOutcome: 'notion_datasource.webhook.outcome',
  webhookRejectionReason: 'notion_datasource.webhook.rejection_reason',
} as const

// ---------------------------------------------------------------------------
// attributes (annotated Effect Schemas; the notion_datasource.* catalog SSOT). Types/cardinality
// are the Weaver catalog metadata; the runtime span encoder in `observability.ts` remains a loose
// value-union keyed by `spanAttrKeys` (behavior-preserving — this migration renames keys, it does
// NOT tighten the pre-existing shared-bag value encode).
// ---------------------------------------------------------------------------

/** Notion API version a request targets. */
export const NotionDatasourceApiVersion = attr.string({
  key: spanAttrKeys.apiVersion,
  cardinality: 'bounded',
  brief: 'Notion API version a request targets.',
  stability: 'development',
  examples: ['2022-06-28'],
})

/** Number of events appended to the store in a sync step. */
export const NotionDatasourceAppendedEvents = attr.number({
  key: spanAttrKeys.appendedEvents,
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of events appended to the store in a sync step.',
  stability: 'development',
  examples: [0, 5],
})

/** 1-based attempt number of an outbox write. */
export const NotionDatasourceAttempt = attr.number({
  key: spanAttrKeys.attempt,
  weaverType: 'int',
  cardinality: 'low',
  brief: '1-based attempt number of an outbox write.',
  stability: 'development',
  examples: [1, 3],
})

/** Number of blocked entries in a sync status snapshot. */
export const NotionDatasourceBlockedCount = attr.number({
  key: spanAttrKeys.blockedCount,
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of blocked entries in a sync status snapshot.',
  stability: 'development',
  examples: [0, 2],
})

/** Body completeness classification for a synced page. */
export const NotionDatasourceBodyCompleteness = attr.string({
  key: spanAttrKeys.bodyCompleteness,
  cardinality: 'bounded',
  brief: 'Body completeness classification for a synced page.',
  stability: 'development',
  examples: ['complete', 'partial'],
})

/** Short digest of a page body's evidence (change-detection fingerprint). */
export const NotionDatasourceBodyEvidenceDigest = attr.string({
  key: spanAttrKeys.bodyEvidenceDigest,
  cardinality: 'high',
  brief: "Short digest of a page body's evidence (change-detection fingerprint).",
  stability: 'development',
  examples: ['a1b2c3d4'],
})

/** Short digest of a page body's identity. */
export const NotionDatasourceBodyIdentityDigest = attr.string({
  key: spanAttrKeys.bodyIdentityDigest,
  cardinality: 'high',
  brief: "Short digest of a page body's identity.",
  stability: 'development',
  examples: ['a1b2c3d4'],
})

/** Identity kind of a synced page body. */
export const NotionDatasourceBodyIdentityKind = attr.string({
  key: spanAttrKeys.bodyIdentityKind,
  cardinality: 'bounded',
  brief: 'Identity kind of a synced page body.',
  stability: 'development',
  examples: ['page', 'database'],
})

/** Short digest of a page body's rendered form. */
export const NotionDatasourceBodyRenderedDigest = attr.string({
  key: spanAttrKeys.bodyRenderedDigest,
  cardinality: 'high',
  brief: "Short digest of a page body's rendered form.",
  stability: 'development',
  examples: ['a1b2c3d4'],
})

/** Whether the operation was cancelled. */
export const NotionDatasourceCancelled = attr.boolean({
  key: spanAttrKeys.cancelled,
  brief: 'Whether the operation was cancelled.',
  stability: 'development',
})

/** Whether a query was capped at its page limit. */
export const NotionDatasourceCappedAtLimit = attr.boolean({
  key: spanAttrKeys.cappedAtLimit,
  brief: 'Whether a query was capped at its page limit.',
  stability: 'development',
})

/** notion-datasource-sync CLI command name. */
export const NotionDatasourceCommand = attr.string({
  key: spanAttrKeys.command,
  cardinality: 'bounded',
  brief: 'notion-datasource-sync CLI command name.',
  stability: 'development',
  examples: ['sync', 'status'],
})

/** Identifier of a queued sync command. */
export const NotionDatasourceCommandId = attr.string({
  key: spanAttrKeys.commandId,
  cardinality: 'high',
  brief: 'Identifier of a queued sync command.',
  stability: 'development',
  examples: ['cmd-2026-07-01'],
})

/** Short kind of a sync command (the command `_tag` without its `Command` suffix). */
export const NotionDatasourceCommandKind = attr.string({
  key: spanAttrKeys.commandKind,
  cardinality: 'bounded',
  brief: 'Short kind of a sync command.',
  stability: 'development',
  examples: ['WriteRemote', 'ObserveSurface'],
})

/** Number of daemon cycles completed. */
export const NotionDatasourceCompletedCycles = attr.number({
  key: spanAttrKeys.completedCycles,
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of daemon cycles completed.',
  stability: 'development',
  examples: [0, 10],
})

/** Number of conflict entries in a sync status snapshot. */
export const NotionDatasourceConflictCount = attr.number({
  key: spanAttrKeys.conflictCount,
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of conflict entries in a sync status snapshot.',
  stability: 'development',
  examples: [0, 1],
})

/** Current daemon cycle index. */
export const NotionDatasourceCycle = attr.number({
  key: spanAttrKeys.cycle,
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Current daemon cycle index.',
  stability: 'development',
  examples: [1, 42],
})

/** Configured number of daemon cycles to run. */
export const NotionDatasourceCycles = attr.number({
  key: spanAttrKeys.cycles,
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Configured number of daemon cycles to run.',
  stability: 'development',
  examples: [1, 100],
})

/** Notion data source (database) id a sync targets. */
export const NotionDatasourceDataSourceId = attr.string({
  key: spanAttrKeys.dataSourceId,
  cardinality: 'high',
  brief: 'Notion data source (database) id a sync targets.',
  stability: 'development',
  examples: ['205d5c1a-0000-4000-8000-000000000000'],
})

/** Whether the run is a dry run. */
export const NotionDatasourceDryRun = attr.boolean({
  key: spanAttrKeys.dryRun,
  brief: 'Whether the run is a dry run.',
  stability: 'development',
})

/** Number of commands enqueued in a sync step. */
export const NotionDatasourceEnqueuedCommands = attr.number({
  key: spanAttrKeys.enqueuedCommands,
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of commands enqueued in a sync step.',
  stability: 'development',
  examples: [0, 5],
})

/** Number of events processed in a sync step. */
export const NotionDatasourceEventCount = attr.number({
  key: spanAttrKeys.eventCount,
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of events processed in a sync step.',
  stability: 'development',
  examples: [0, 12],
})

/** Number of executor steps taken in a sync pass. */
export const NotionDatasourceExecutorSteps = attr.number({
  key: spanAttrKeys.executorSteps,
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of executor steps taken in a sync pass.',
  stability: 'development',
  examples: [1, 8],
})

/** Guard that governed a write. */
export const NotionDatasourceGuard = attr.string({
  key: spanAttrKeys.guard,
  cardinality: 'bounded',
  brief: 'Guard that governed a write.',
  stability: 'development',
  examples: ['force', 'safe'],
})

/** Number of incomplete properties in a sync status snapshot. */
export const NotionDatasourceIncompletePropertyCount = attr.number({
  key: spanAttrKeys.incompletePropertyCount,
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of incomplete properties in a sync status snapshot.',
  stability: 'development',
  examples: [0, 3],
})

/** Lease duration (ms) acquired for a daemon pass. */
export const NotionDatasourceLeaseDurationMs = attr.number({
  key: spanAttrKeys.leaseDurationMs,
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Lease duration (ms) acquired for a daemon pass.',
  stability: 'development',
  examples: [1000, 30000],
})

/** Number of local observations gathered in a sync pass. */
export const NotionDatasourceLocalObservationCount = attr.number({
  key: spanAttrKeys.localObservationCount,
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of local observations gathered in a sync pass.',
  stability: 'development',
  examples: [0, 20],
})

/** Configured maximum number of daemon cycles. */
export const NotionDatasourceMaxCycles = attr.number({
  key: spanAttrKeys.maxCycles,
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Configured maximum number of daemon cycles.',
  stability: 'development',
  examples: [1, 100],
})

/** Configured maximum number of executor steps per pass. */
export const NotionDatasourceMaxExecutorSteps = attr.number({
  key: spanAttrKeys.maxExecutorSteps,
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Configured maximum number of executor steps per pass.',
  stability: 'development',
  examples: [8, 64],
})

/** Whether the executor stopped because it hit its step cap. */
export const NotionDatasourceMaxStepsReached = attr.boolean({
  key: spanAttrKeys.maxStepsReached,
  brief: 'Whether the executor stopped because it hit its step cap.',
  stability: 'development',
})

/** Sync authority/direction mode. */
export const NotionDatasourceMode = attr.string({
  key: spanAttrKeys.mode,
  cardinality: 'bounded',
  brief: 'Sync authority/direction mode.',
  stability: 'development',
  examples: ['watch', 'one-shot'],
})

/** Bounded gateway operation endpoint a `notion.api.request` span/metric is labelled by (never an id). */
export const NotionDatasourceOperation = attr.string({
  key: spanAttrKeys.operation,
  cardinality: 'bounded',
  brief: 'Bounded gateway operation endpoint a request is labelled by (never an id).',
  stability: 'development',
  examples: ['queryRows', 'patchPageProperties'],
})

/** Number of ambiguous outbox entries in a sync status snapshot. */
export const NotionDatasourceOutboxAmbiguousCount = attr.number({
  key: spanAttrKeys.outboxAmbiguousCount,
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of ambiguous outbox entries in a sync status snapshot.',
  stability: 'development',
  examples: [0, 3],
})

/** Number of blocked outbox entries in a sync status snapshot. */
export const NotionDatasourceOutboxBlockedCount = attr.number({
  key: spanAttrKeys.outboxBlockedCount,
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of blocked outbox entries in a sync status snapshot.',
  stability: 'development',
  examples: [0, 4],
})

/** Number of queued outbox entries in a sync status snapshot. */
export const NotionDatasourceOutboxQueuedCount = attr.number({
  key: spanAttrKeys.outboxQueuedCount,
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of queued outbox entries in a sync status snapshot.',
  stability: 'development',
  examples: [0, 5],
})

/** Number of retryable outbox entries in a sync status snapshot. */
export const NotionDatasourceOutboxRetryableCount = attr.number({
  key: spanAttrKeys.outboxRetryableCount,
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of retryable outbox entries in a sync status snapshot.',
  stability: 'development',
  examples: [0, 6],
})

/** Number of running outbox entries in a sync status snapshot. */
export const NotionDatasourceOutboxRunningCount = attr.number({
  key: spanAttrKeys.outboxRunningCount,
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of running outbox entries in a sync status snapshot.',
  stability: 'development',
  examples: [0, 7],
})

/** Notion page id a sync operates on. */
export const NotionDatasourcePageId = attr.string({
  key: spanAttrKeys.pageId,
  cardinality: 'high',
  brief: 'Notion page id a sync operates on.',
  stability: 'development',
  examples: ['205d5c1a-0000-4000-8000-000000000000'],
})

/** Kind of process emitting a span. */
export const NotionDatasourceProcessRole = attr.string({
  key: spanAttrKeys.processRole,
  cardinality: 'bounded',
  brief: 'Kind of process emitting a span.',
  stability: 'development',
  examples: ['cli', 'daemon', 'library'],
})

/** Notion property id a sync operates on. */
export const NotionDatasourcePropertyId = attr.string({
  key: spanAttrKeys.propertyId,
  cardinality: 'high',
  brief: 'Notion property id a sync operates on.',
  stability: 'development',
  examples: ['prop-abc123'],
})

/** Whether a data-source query completed (vs was capped/interrupted). */
export const NotionDatasourceQueryComplete = attr.boolean({
  key: spanAttrKeys.queryComplete,
  brief: 'Whether a data-source query completed (vs was capped/interrupted).',
  stability: 'development',
})

/** Number of pages returned by a data-source query. */
export const NotionDatasourceQueryPageCount = attr.number({
  key: spanAttrKeys.queryPageCount,
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of pages returned by a data-source query.',
  stability: 'development',
  examples: [0, 25],
})

/** Terminal result of an operation. */
export const NotionDatasourceResult = attr.string({
  key: spanAttrKeys.result,
  cardinality: 'bounded',
  brief: 'Terminal result of an operation.',
  stability: 'development',
  examples: ['ok', 'skipped', 'failed'],
})

/** Root id of the synced tree/data source. */
export const NotionDatasourceRootId = attr.string({
  key: spanAttrKeys.rootId,
  cardinality: 'high',
  brief: 'Root id of the synced tree/data source.',
  stability: 'development',
  examples: ['205d5c1a-0000-4000-8000-000000000000'],
})

/** Number of rows considered in a sync operation. */
export const NotionDatasourceRowCount = attr.number({
  key: spanAttrKeys.rowCount,
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of rows considered in a sync operation.',
  stability: 'development',
  examples: [0, 100],
})

/** Settlement kind for an outbox write. */
export const NotionDatasourceSettlementKind = attr.string({
  key: spanAttrKeys.settlementKind,
  cardinality: 'bounded',
  brief: 'Settlement kind for an outbox write.',
  stability: 'development',
  examples: ['applied', 'noop'],
})

/** Overall sync status state. */
export const NotionDatasourceStatusState = attr.string({
  key: spanAttrKeys.statusState,
  cardinality: 'bounded',
  brief: 'Overall sync status state.',
  stability: 'development',
  examples: ['clean', 'pending', 'conflict', 'blocked'],
})

/** Wake trigger source for a daemon pass. */
export const NotionDatasourceWakeSource = attr.string({
  key: spanAttrKeys.wakeSource,
  cardinality: 'bounded',
  brief: "Wake trigger source for a daemon pass ('webhook' | 'signal' | 'poll').",
  stability: 'development',
  examples: ['webhook', 'signal', 'poll'],
})

/** Notion event type from an incoming webhook payload. */
export const NotionDatasourceWebhookEventType = attr.string({
  key: spanAttrKeys.webhookEventType,
  cardinality: 'bounded',
  brief: 'Notion event type from an incoming webhook payload.',
  stability: 'development',
  examples: ['page.created', 'page.updated'],
})

/** Outcome of one webhook delivery attempt. */
export const NotionDatasourceWebhookOutcome = attr.string({
  key: spanAttrKeys.webhookOutcome,
  cardinality: 'bounded',
  brief:
    "Outcome of one webhook delivery attempt ('enqueued' | 'duplicate' | 'verification' | 'rejected').",
  stability: 'development',
  examples: ['enqueued', 'duplicate', 'rejected'],
})

/** Stable rejection reason when a webhook delivery is rejected (never raw payload material). */
export const NotionDatasourceWebhookRejectionReason = attr.string({
  key: spanAttrKeys.webhookRejectionReason,
  cardinality: 'bounded',
  brief:
    'Stable rejection reason when a webhook delivery is rejected (never raw payload material).',
  stability: 'development',
  examples: ['bad-signature', 'unknown-surface'],
})

// ---------------------------------------------------------------------------
// request counter (RAW OtelMetric — no `metric()` signal). The counter has no unit, which the
// registry `metric()` DSL cannot express; its label key is namespaced already and lands in the
// catalog via `docOnlyAttributes` (mirroring notion-effect-client's rate-limit counters).
// ---------------------------------------------------------------------------

/**
 * The full set of gateway operation names that can label a `notion.api.request` span / metric,
 * kept in lockstep with `gateway.ts`'s `GatewayOperation` union. Bounded cardinality: exactly these
 * 13 logical endpoints, never an id.
 */
export const gatewayOperationNames = [
  'preflightCapabilities',
  'retrieveDataSource',
  'queryRows',
  'retrievePage',
  'retrievePageProperty',
  'listDataSourceViews',
  'patchPageProperties',
  'createPage',
  'patchDataSourceSchema',
  'patchDataSourceMetadata',
  'patchDatabaseMetadata',
  'trashPage',
  'restorePage',
] as const

/** Operation name labelling a `notion.api.request` — the bounded `operation` metric/span dimension. */
export type GatewayRequestOperation = (typeof gatewayOperationNames)[number]

/**
 * Production request-count metric for the call-count budget (EFF-R01, decision 0017 Half 1). Counts
 * LOGICAL `notion.api.request` calls — one per gateway op invocation — labelled only by the bounded
 * `notion_datasource.operation` endpoint (never an id), so a regression that adds a per-entity read
 * shows up as fleet-visible request growth.
 */
export const notionApiRequestsTotal = OtelMetric.counter({
  name: 'notion_datasource_api_requests_total',
  description:
    'Logical Notion API requests issued by the datasource-sync gateway, by operation endpoint.',
  labels: Schema.Struct({
    operation: OtelAttr.literal(spanAttrKeys.operation, ...gatewayOperationNames),
  }),
})

// ---------------------------------------------------------------------------
// contract seam (namespace `notion_datasource`, derived). Attrs-only member (see file docstring):
// every key reaches telemetry via the shared-bag runtime spans or the raw counter, none of which
// has a stable single-signal projection — so the whole catalog reaches the registry via docOnly.
// ---------------------------------------------------------------------------

export default defineOtelContract({
  memberPath: 'packages/@overeng/notion-datasource-sync',
  displayName: 'Notion Datasource Sync Attributes',
  signals: [],
  docOnlyAttributes: [
    NotionDatasourceApiVersion,
    NotionDatasourceAppendedEvents,
    NotionDatasourceAttempt,
    NotionDatasourceBlockedCount,
    NotionDatasourceBodyCompleteness,
    NotionDatasourceBodyEvidenceDigest,
    NotionDatasourceBodyIdentityDigest,
    NotionDatasourceBodyIdentityKind,
    NotionDatasourceBodyRenderedDigest,
    NotionDatasourceCancelled,
    NotionDatasourceCappedAtLimit,
    NotionDatasourceCommand,
    NotionDatasourceCommandId,
    NotionDatasourceCommandKind,
    NotionDatasourceCompletedCycles,
    NotionDatasourceConflictCount,
    NotionDatasourceCycle,
    NotionDatasourceCycles,
    NotionDatasourceDataSourceId,
    NotionDatasourceDryRun,
    NotionDatasourceEnqueuedCommands,
    NotionDatasourceEventCount,
    NotionDatasourceExecutorSteps,
    NotionDatasourceGuard,
    NotionDatasourceIncompletePropertyCount,
    NotionDatasourceLeaseDurationMs,
    NotionDatasourceLocalObservationCount,
    NotionDatasourceMaxCycles,
    NotionDatasourceMaxExecutorSteps,
    NotionDatasourceMaxStepsReached,
    NotionDatasourceMode,
    NotionDatasourceOperation,
    NotionDatasourceOutboxAmbiguousCount,
    NotionDatasourceOutboxBlockedCount,
    NotionDatasourceOutboxQueuedCount,
    NotionDatasourceOutboxRetryableCount,
    NotionDatasourceOutboxRunningCount,
    NotionDatasourcePageId,
    NotionDatasourceProcessRole,
    NotionDatasourcePropertyId,
    NotionDatasourceQueryComplete,
    NotionDatasourceQueryPageCount,
    NotionDatasourceResult,
    NotionDatasourceRootId,
    NotionDatasourceRowCount,
    NotionDatasourceSettlementKind,
    NotionDatasourceStatusState,
    NotionDatasourceWakeSource,
    NotionDatasourceWebhookEventType,
    NotionDatasourceWebhookOutcome,
    NotionDatasourceWebhookRejectionReason,
  ],
})
