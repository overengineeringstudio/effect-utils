import { Effect, Schema, Stream } from 'effect'

import {
  OtelAttr,
  OtelAttrs,
  OtelOperation,
  OtelSpan,
  type OtelAttributeValue,
} from '@overeng/otel-contract'

import type { OneShotStatusState, OneShotSyncStatus } from '../core/status.ts'

/** OTel service names used when registering the CLI and daemon tracer providers. */
export const otelServiceNames = {
  cli: 'notion-datasource-sync-cli',
  daemon: 'notion-datasource-sync-daemon',
} as const

/** Canonical OTel span names for every traced operation in the sync pipeline and CLI. */
export const spanNames = {
  cliCommand: 'notion.datasource.cli',
  daemonPass: 'notion.datasource.daemon.pass',
  daemonRun: 'notion.datasource.daemon.run',
  fakeGatewayRequest: 'notion.datasource.fake-gateway.request',
  gatewayRequest: 'notion.api.request',
  observationLocal: 'notion.datasource.observation.local',
  observationRemote: 'notion.datasource.observation.remote',
  outboxAttempt: 'notion.datasource.outbox.attempt',
  outboxObserveSurface: 'notion.datasource.outbox.observe-surface',
  outboxWriteRemote: 'notion.datasource.outbox.write-remote',
  syncEstablishFromNotion: 'notion.datasource.sync.establish-from-notion',
  syncInit: 'notion.datasource.sync.init',
  syncPull: 'notion.datasource.sync.pull',
  syncPush: 'notion.datasource.sync.push',
  syncOneShot: 'notion.datasource.sync.one-shot',
  syncQueryAbsence: 'notion.datasource.sync.query-absence',
} as const

/** Typed map of every OTel span attribute key emitted by this package — use instead of raw strings. */
export const spanAttr = {
  agentIterationId: 'agent.iteration.id',
  apiVersion: 'notion.datasource.api_version',
  appendedEvents: 'notion.datasource.appended_events',
  attempt: 'notion.datasource.attempt',
  blockedCount: 'notion.datasource.blocked_count',
  bodyCompleteness: 'notion.datasource.body.completeness',
  bodyEvidenceDigest: 'notion.datasource.body.evidence.digest',
  bodyIdentityDigest: 'notion.datasource.body.identity.digest',
  bodyIdentityKind: 'notion.datasource.body.identity.kind',
  bodyRenderedDigest: 'notion.datasource.body.rendered.digest',
  cancelled: 'notion.datasource.cancelled',
  cappedAtLimit: 'notion.datasource.capped_at_limit',
  command: 'notion.datasource.command',
  commandId: 'notion.datasource.command_id',
  commandKind: 'notion.datasource.command_kind',
  completedCycles: 'notion.datasource.completed_cycles',
  conflictCount: 'notion.datasource.conflict_count',
  cycle: 'notion.datasource.cycle',
  cycles: 'notion.datasource.cycles',
  dataSourceId: 'notion.datasource.data_source_id',
  dryRun: 'notion.datasource.dry_run',
  enqueuedCommands: 'notion.datasource.enqueued_commands',
  eventCount: 'notion.datasource.event_count',
  executorSteps: 'notion.datasource.executor_steps',
  guard: 'notion.datasource.guard',
  incompletePropertyCount: 'notion.datasource.incomplete_property_count',
  leaseDurationMs: 'notion.datasource.lease_duration_ms',
  localObservationCount: 'notion.datasource.local_observation_count',
  maxCycles: 'notion.datasource.max_cycles',
  maxExecutorSteps: 'notion.datasource.max_executor_steps',
  maxStepsReached: 'notion.datasource.max_steps_reached',
  mode: 'notion.datasource.mode',
  operation: 'notion.datasource.operation',
  outboxAmbiguousCount: 'notion.datasource.outbox_ambiguous_count',
  outboxBlockedCount: 'notion.datasource.outbox_blocked_count',
  outboxQueuedCount: 'notion.datasource.outbox_queued_count',
  outboxRetryableCount: 'notion.datasource.outbox_retryable_count',
  outboxRunningCount: 'notion.datasource.outbox_running_count',
  pageId: 'notion.datasource.page_id',
  processRole: 'notion.datasource.process.role',
  propertyId: 'notion.datasource.property_id',
  queryComplete: 'notion.datasource.query_complete',
  queryPageCount: 'notion.datasource.query_page_count',
  result: 'notion.datasource.result',
  rootId: 'notion.datasource.root_id',
  rowCount: 'notion.datasource.row_count',
  settlementKind: 'notion.datasource.settlement_kind',
  spanLabel: 'span.label',
  statusState: 'notion.datasource.status.state',
} as const

/** Canonical OTel span attribute keys emitted by this package. */
export type SpanAttributeKey = (typeof spanAttr)[keyof typeof spanAttr]

/** Scalar types accepted as OTel span attribute values. */
export type SpanAttributeValue = OtelAttributeValue

type SpanAttributesInput = Partial<Record<SpanAttributeKey, SpanAttributeValue | undefined>>

type SpanAttributesWithLabel = SpanAttributesInput & {
  readonly [spanAttr.spanLabel]: string
}

/** Identifies the kind of process emitting a span, recorded on `spanAttr.processRole`. */
export type ProcessRole = 'cli' | 'daemon' | 'fake-gateway' | 'library'

const SpanAttributeValueSchema = Schema.Union(Schema.String, Schema.Number, Schema.Boolean)

const optionalAttr = (key: SpanAttributeKey) =>
  Schema.optional(SpanAttributeValueSchema.pipe(OtelAttr.key({ key })))

const SpanAttributesSchema = Schema.Struct({
  [spanAttr.agentIterationId]: optionalAttr(spanAttr.agentIterationId),
  [spanAttr.apiVersion]: optionalAttr(spanAttr.apiVersion),
  [spanAttr.appendedEvents]: optionalAttr(spanAttr.appendedEvents),
  [spanAttr.attempt]: optionalAttr(spanAttr.attempt),
  [spanAttr.blockedCount]: optionalAttr(spanAttr.blockedCount),
  [spanAttr.bodyCompleteness]: optionalAttr(spanAttr.bodyCompleteness),
  [spanAttr.bodyEvidenceDigest]: optionalAttr(spanAttr.bodyEvidenceDigest),
  [spanAttr.bodyIdentityDigest]: optionalAttr(spanAttr.bodyIdentityDigest),
  [spanAttr.bodyIdentityKind]: optionalAttr(spanAttr.bodyIdentityKind),
  [spanAttr.bodyRenderedDigest]: optionalAttr(spanAttr.bodyRenderedDigest),
  [spanAttr.cancelled]: optionalAttr(spanAttr.cancelled),
  [spanAttr.cappedAtLimit]: optionalAttr(spanAttr.cappedAtLimit),
  [spanAttr.command]: optionalAttr(spanAttr.command),
  [spanAttr.commandId]: optionalAttr(spanAttr.commandId),
  [spanAttr.commandKind]: optionalAttr(spanAttr.commandKind),
  [spanAttr.completedCycles]: optionalAttr(spanAttr.completedCycles),
  [spanAttr.conflictCount]: optionalAttr(spanAttr.conflictCount),
  [spanAttr.cycle]: optionalAttr(spanAttr.cycle),
  [spanAttr.cycles]: optionalAttr(spanAttr.cycles),
  [spanAttr.dataSourceId]: optionalAttr(spanAttr.dataSourceId),
  [spanAttr.dryRun]: optionalAttr(spanAttr.dryRun),
  [spanAttr.enqueuedCommands]: optionalAttr(spanAttr.enqueuedCommands),
  [spanAttr.eventCount]: optionalAttr(spanAttr.eventCount),
  [spanAttr.executorSteps]: optionalAttr(spanAttr.executorSteps),
  [spanAttr.guard]: optionalAttr(spanAttr.guard),
  [spanAttr.incompletePropertyCount]: optionalAttr(spanAttr.incompletePropertyCount),
  [spanAttr.leaseDurationMs]: optionalAttr(spanAttr.leaseDurationMs),
  [spanAttr.localObservationCount]: optionalAttr(spanAttr.localObservationCount),
  [spanAttr.maxCycles]: optionalAttr(spanAttr.maxCycles),
  [spanAttr.maxExecutorSteps]: optionalAttr(spanAttr.maxExecutorSteps),
  [spanAttr.maxStepsReached]: optionalAttr(spanAttr.maxStepsReached),
  [spanAttr.mode]: optionalAttr(spanAttr.mode),
  [spanAttr.operation]: optionalAttr(spanAttr.operation),
  [spanAttr.outboxAmbiguousCount]: optionalAttr(spanAttr.outboxAmbiguousCount),
  [spanAttr.outboxBlockedCount]: optionalAttr(spanAttr.outboxBlockedCount),
  [spanAttr.outboxQueuedCount]: optionalAttr(spanAttr.outboxQueuedCount),
  [spanAttr.outboxRetryableCount]: optionalAttr(spanAttr.outboxRetryableCount),
  [spanAttr.outboxRunningCount]: optionalAttr(spanAttr.outboxRunningCount),
  [spanAttr.pageId]: optionalAttr(spanAttr.pageId),
  [spanAttr.processRole]: optionalAttr(spanAttr.processRole),
  [spanAttr.propertyId]: optionalAttr(spanAttr.propertyId),
  [spanAttr.queryComplete]: optionalAttr(spanAttr.queryComplete),
  [spanAttr.queryPageCount]: optionalAttr(spanAttr.queryPageCount),
  [spanAttr.result]: optionalAttr(spanAttr.result),
  [spanAttr.rootId]: optionalAttr(spanAttr.rootId),
  [spanAttr.rowCount]: optionalAttr(spanAttr.rowCount),
  [spanAttr.settlementKind]: optionalAttr(spanAttr.settlementKind),
  [spanAttr.spanLabel]: Schema.optional(Schema.String.pipe(OtelAttr.spanLabel())),
  [spanAttr.statusState]: optionalAttr(spanAttr.statusState),
})

/** Schema-backed contract for package-level span attributes keyed by their emitted OTel names. */
export const notionDatasourceSpanAttributes = OtelAttrs.defineSync(SpanAttributesSchema)

/** Schema-backed operation contracts for the existing span catalog. */
export const spanContracts = Object.fromEntries(
  Object.entries(spanNames).map(([key, name]) => [
    key,
    OtelOperation.define({
      name,
      attributes: notionDatasourceSpanAttributes,
      label: (attributes: typeof SpanAttributesSchema.Type) => attributes[spanAttr.spanLabel] ?? '',
    }),
  ]),
) as {
  readonly [K in keyof typeof spanNames]: ReturnType<
    typeof OtelOperation.define<typeof SpanAttributesSchema>
  >
}

const StatusSpanAttributesSchema = Schema.Struct({
  state: Schema.Literal('clean', 'pending', 'conflict', 'blocked').pipe(
    OtelAttr.key({ key: spanAttr.statusState }),
  ),
  blockedCount: Schema.NonNegativeInt.pipe(OtelAttr.key({ key: spanAttr.blockedCount })),
  conflictCount: Schema.NonNegativeInt.pipe(OtelAttr.key({ key: spanAttr.conflictCount })),
  outboxAmbiguousCount: Schema.NonNegativeInt.pipe(
    OtelAttr.key({ key: spanAttr.outboxAmbiguousCount }),
  ),
  outboxBlockedCount: Schema.NonNegativeInt.pipe(
    OtelAttr.key({ key: spanAttr.outboxBlockedCount }),
  ),
  outboxQueuedCount: Schema.NonNegativeInt.pipe(OtelAttr.key({ key: spanAttr.outboxQueuedCount })),
  outboxRetryableCount: Schema.NonNegativeInt.pipe(
    OtelAttr.key({ key: spanAttr.outboxRetryableCount }),
  ),
  outboxRunningCount: Schema.NonNegativeInt.pipe(
    OtelAttr.key({ key: spanAttr.outboxRunningCount }),
  ),
})

/** Schema-backed contract for status summary attributes emitted on sync result spans. */
export const statusSpanAttrs = OtelAttrs.defineSync(StatusSpanAttributesSchema)

const CorrelationSpanAttributesSchema = Schema.Struct({
  agentIterationId: Schema.optional(
    Schema.String.pipe(OtelAttr.key({ key: spanAttr.agentIterationId })),
  ),
})

/** Schema-backed contract for agent correlation attributes copied onto command spans. */
export const correlationSpanAttrs = OtelAttrs.defineSync(CorrelationSpanAttributesSchema)

/** Filters out `undefined` values from an attribute map so it can be passed directly to OTel span APIs. */
export const spanAttributes = (
  attributes: SpanAttributesInput,
): Record<string, SpanAttributeValue> =>
  notionDatasourceSpanAttributes.encodeSync(attributes as typeof SpanAttributesSchema.Type)

/** Attach one of this package's cataloged spans with schema-backed attributes. */
export const withSpan =
  ({
    span,
    attributes,
  }: {
    readonly span: keyof typeof spanContracts
    readonly attributes: SpanAttributesWithLabel
  }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    spanContracts[span]
      .with({
        attributes: attributes as typeof SpanAttributesSchema.Type,
        effect,
      })
      .pipe(Effect.catchTag('OtelAttrEncodeError', (error) => Effect.die(error)))

/** Attach one of this package's cataloged spans to a stream with schema-backed attributes. */
export const withStreamSpan =
  ({
    span,
    attributes,
  }: {
    readonly span: keyof typeof spanContracts
    readonly attributes: SpanAttributesWithLabel
  }) =>
  <A, E, R>(stream: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> =>
    spanContracts[span]
      .withStream({
        attributes: attributes as typeof SpanAttributesSchema.Type,
        stream,
      })
      .pipe(
        Stream.catchAll((error) =>
          typeof error === 'object' &&
          error !== null &&
          '_tag' in error &&
          error._tag === 'OtelAttrEncodeError'
            ? Stream.die(error)
            : Stream.fail(error as E),
        ),
      )

/** Annotate the active span using this package's schema-backed attribute contract. */
export const annotateSpan = (attributes: SpanAttributesInput): Effect.Effect<void> =>
  OtelSpan.annotate({
    attributes: notionDatasourceSpanAttributes,
    value: attributes as typeof SpanAttributesSchema.Type,
  }).pipe(Effect.catchTag('OtelAttrEncodeError', (error) => Effect.die(error)))

/** Truncates a span / root ID to at most 12 characters for use in human-readable `span.label` values. */
export const shortSpanId = (value: string): string =>
  value.length <= 12 ? value : value.slice(0, 12)

/**
 * Joins non-empty parts into a colon-delimited `span.label` string, capped at 39 characters.
 *
 * Used to build a compact human-readable identifier (e.g. `"cycle:42"`) stored on `spanAttr.spanLabel`.
 */
export const spanLabel = (
  ...parts: ReadonlyArray<string | number | boolean | undefined>
): string => {
  const label = parts
    .filter((part) => part !== undefined && String(part).length > 0)
    .map((part) => String(part))
    .join(':')
  return label.length <= 39 ? label : label.slice(0, 39)
}

/** Strips the `Command` suffix from a command `_tag` to get a short kind string for span attributes. */
export const commandKind = (tag: string): string => tag.replace(/Command$/, '')

/** Maps a CLI command to its `ProcessRole` — `sync --watch` becomes `daemon`, everything else becomes `cli`. */
// oxlint-disable-next-line overeng/named-args -- public helper mirrors argv-style command plus options.
export const processRoleForCliCommand = (
  command: string,
  options: { readonly watch?: boolean } = {},
): ProcessRole => (command === 'sync' && options.watch === true ? 'daemon' : 'cli')

/** Picks the correct OTel service name from raw `argv` (before full parsing) — `sync --watch` uses the daemon service. */
export const otelServiceNameForCliArgv = (argv: ReadonlyArray<string>): string =>
  argv[0] === 'sync' && argv.includes('--watch') === true
    ? otelServiceNames.daemon
    : otelServiceNames.cli

/**
 * Converts a `OneShotSyncStatus` snapshot into OTel span attributes.
 *
 * Emits state, per-category counts (blocked, conflict, outbox buckets) so dashboards
 * can filter or alert on sync health without parsing log messages.
 */
export const statusSpanAttributes = (
  status: OneShotSyncStatus,
): Record<string, SpanAttributeValue> =>
  statusSpanAttrs.encodeSync({
    state: status.state satisfies OneShotStatusState,
    blockedCount: status.counts.blocked,
    conflictCount: status.counts.conflict,
    outboxAmbiguousCount: status.counts.outbox.ambiguous,
    outboxBlockedCount: status.counts.outbox.blocked,
    outboxQueuedCount: status.counts.outbox.queued,
    outboxRetryableCount: status.counts.outbox.retryable,
    outboxRunningCount: status.counts.outbox.running,
  })

const resourceAttributeValue = ({
  input,
  key,
}: {
  readonly input: string | undefined
  readonly key: string
}): string | undefined =>
  input
    ?.split(',')
    .map((entry) => entry.split('='))
    .find((entry) => entry.length === 2 && entry[0]?.trim() === key)?.[1]
    ?.trim()

/**
 * Extracts correlation attributes (`agent.iteration.id`) from an agent run ID or
 * a raw `OTEL_RESOURCE_ATTRIBUTES` string and returns them as span attributes.
 *
 * Used to link CLI/daemon spans back to the orchestrating agent's iteration when
 * the process is launched by an automated runner.
 */
export const otelCorrelationSpanAttributes = (input: {
  readonly agentRunId?: string | undefined
  readonly resourceAttributes?: string | undefined
}): Record<string, SpanAttributeValue> =>
  correlationSpanAttrs.encodeSync({
    agentIterationId:
      input.agentRunId ??
      resourceAttributeValue({ input: input.resourceAttributes, key: spanAttr.agentIterationId }),
  })
