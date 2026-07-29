import { Effect, Schema, Stream } from 'effect'

import {
  OtelAttr,
  OtelAttrs,
  OtelMetric,
  OtelOperation,
  OtelSpan,
  type OtelAttributeValue,
} from '@overeng/otel-contract'

import type { OneShotStatusState, OneShotSyncStatus } from '../core/status.ts'
import {
  gatewayOperationNames,
  notionApiRequestsTotal,
  spanAttrKeys,
  type GatewayRequestOperation,
} from './notion-datasource.contract.ts'

/** OTel service names used when registering the CLI and daemon tracer providers. */
export const otelServiceNames = {
  cli: 'notion-datasource-sync-cli',
  daemon: 'notion-datasource-sync-daemon',
} as const

/**
 * Canonical OTel span names for every traced operation in the sync pipeline and CLI. Renamed
 * `notion.datasource.*` → `notion_datasource.*` (breaking wire rename, approved) to match the
 * disjoint `notion_datasource` attribute namespace. `gatewayRequest` stays `notion.api.request` (it
 * names the actual outbound Notion API call, not a `notion.datasource.*` internal span).
 */
export const spanNames = {
  cliCommand: 'notion_datasource.cli',
  daemonPass: 'notion_datasource.daemon.pass',
  daemonRun: 'notion_datasource.daemon.run',
  fakeGatewayRequest: 'notion_datasource.fake-gateway.request',
  gatewayRequest: 'notion.api.request',
  observationLocal: 'notion_datasource.observation.local',
  observationRemote: 'notion_datasource.observation.remote',
  outboxAttempt: 'notion_datasource.outbox.attempt',
  outboxObserveSurface: 'notion_datasource.outbox.observe-surface',
  outboxWriteRemote: 'notion_datasource.outbox.write-remote',
  syncEstablishFromNotion: 'notion_datasource.sync.establish-from-notion',
  syncInit: 'notion_datasource.sync.init',
  syncPull: 'notion_datasource.sync.pull',
  syncPush: 'notion_datasource.sync.push',
  syncOneShot: 'notion_datasource.sync.one-shot',
  syncQueryAbsence: 'notion_datasource.sync.query-absence',
  webhookIntake: 'notion_datasource.webhook.intake',
} as const

/**
 * Typed map of every OTel span attribute key emitted by this package — use instead of raw strings.
 * DERIVED from the registered seam contract's `spanAttrKeys` (the single SSOT for the renamed
 * `notion_datasource.*` keys); re-exported here as the package's public `spanAttr` API.
 */
export const spanAttr = spanAttrKeys

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
  [spanAttr.wakeSource]: optionalAttr(spanAttr.wakeSource),
  [spanAttr.webhookEventType]: optionalAttr(spanAttr.webhookEventType),
  [spanAttr.webhookOutcome]: optionalAttr(spanAttr.webhookOutcome),
  [spanAttr.webhookRejectionReason]: optionalAttr(spanAttr.webhookRejectionReason),
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
  blockedCount: Schema.Natural.pipe(OtelAttr.key({ key: spanAttr.blockedCount })),
  conflictCount: Schema.Natural.pipe(OtelAttr.key({ key: spanAttr.conflictCount })),
  outboxAmbiguousCount: Schema.Natural.pipe(OtelAttr.key({ key: spanAttr.outboxAmbiguousCount })),
  outboxBlockedCount: Schema.Natural.pipe(OtelAttr.key({ key: spanAttr.outboxBlockedCount })),
  outboxQueuedCount: Schema.Natural.pipe(OtelAttr.key({ key: spanAttr.outboxQueuedCount })),
  outboxRetryableCount: Schema.Natural.pipe(OtelAttr.key({ key: spanAttr.outboxRetryableCount })),
  outboxRunningCount: Schema.Natural.pipe(OtelAttr.key({ key: spanAttr.outboxRunningCount })),
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

/**
 * The full set of gateway operation names + the request-count metric are DERIVED from the seam
 * contract (`./notion-datasource.contract.ts`), re-exported here so `gateway.ts` and the rest of the
 * package keep importing them from the package observability surface.
 */
export { gatewayOperationNames, notionApiRequestsTotal, type GatewayRequestOperation }

const notionApiRequestsTotalBridge = OtelMetric.effect.counter(notionApiRequestsTotal)

/**
 * Increment the logical-request counter for one gateway op invocation. Uses
 * `trustedIncrement` so a (statically impossible) label encode error becomes a
 * defect rather than leaking into the gateway methods' error channel.
 */
export const incrementNotionApiRequest = (
  operation: GatewayRequestOperation,
): Effect.Effect<void> => notionApiRequestsTotalBridge.trustedIncrement({ operation })
