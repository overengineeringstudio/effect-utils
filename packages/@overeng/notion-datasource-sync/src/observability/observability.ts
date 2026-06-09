import type { OneShotSyncStatus } from '../core/status.ts'

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

/** Scalar types accepted as OTel span attribute values. */
export type SpanAttributeValue = string | number | boolean

/** Identifies the kind of process emitting a span, recorded on `spanAttr.processRole`. */
export type ProcessRole = 'cli' | 'daemon' | 'fake-gateway' | 'library'

/** Filters out `undefined` values from an attribute map so it can be passed directly to OTel span APIs. */
export const spanAttributes = (
  attributes: Record<string, SpanAttributeValue | undefined>,
): Record<string, SpanAttributeValue> =>
  Object.fromEntries(
    Object.entries(attributes).filter((entry): entry is [string, SpanAttributeValue] => {
      const value = entry[1]
      return value !== undefined
    }),
  )

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
  spanAttributes({
    [spanAttr.statusState]: status.state,
    [spanAttr.blockedCount]: status.counts.blocked,
    [spanAttr.conflictCount]: status.counts.conflict,
    [spanAttr.outboxAmbiguousCount]: status.counts.outbox.ambiguous,
    [spanAttr.outboxBlockedCount]: status.counts.outbox.blocked,
    [spanAttr.outboxQueuedCount]: status.counts.outbox.queued,
    [spanAttr.outboxRetryableCount]: status.counts.outbox.retryable,
    [spanAttr.outboxRunningCount]: status.counts.outbox.running,
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
  spanAttributes({
    [spanAttr.agentIterationId]:
      input.agentRunId ??
      resourceAttributeValue({ input: input.resourceAttributes, key: spanAttr.agentIterationId }),
  })
