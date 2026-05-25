import type { OneShotSyncStatus } from './status.ts'

export const otelServiceNames = {
  cli: 'notion-datasource-sync-cli',
  daemon: 'notion-datasource-sync-daemon',
} as const

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
  syncInit: 'notion.datasource.sync.init',
  syncPull: 'notion.datasource.sync.pull',
  syncPush: 'notion.datasource.sync.push',
  syncOneShot: 'notion.datasource.sync.one-shot',
} as const

export const spanAttr = {
  agentIterationId: 'agent.iteration.id',
  apiVersion: 'notion.datasource.api_version',
  appendedEvents: 'notion.datasource.appended_events',
  attempt: 'notion.datasource.attempt',
  blockedCount: 'notion.datasource.blocked_count',
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

export type SpanAttributeValue = string | number | boolean

export type ProcessRole = 'cli' | 'daemon' | 'fake-gateway' | 'library'

export const spanAttributes = (
  attributes: Record<string, SpanAttributeValue | undefined>,
): Record<string, SpanAttributeValue> =>
  Object.fromEntries(
    Object.entries(attributes).filter((entry): entry is [string, SpanAttributeValue] => {
      const value = entry[1]
      return value !== undefined
    }),
  )

export const shortSpanId = (value: string): string =>
  value.length <= 12 ? value : value.slice(0, 12)

export const spanLabel = (
  ...parts: ReadonlyArray<string | number | boolean | undefined>
): string => {
  const label = parts
    .filter((part) => part !== undefined && String(part).length > 0)
    .map((part) => String(part))
    .join(':')
  return label.length <= 39 ? label : label.slice(0, 39)
}

export const commandKind = (tag: string): string => tag.replace(/Command$/, '')

export const processRoleForCliCommand = (command: string): ProcessRole =>
  command === 'watch' ? 'daemon' : 'cli'

export const otelServiceNameForCliArgv = (argv: ReadonlyArray<string>): string =>
  argv[0] === 'watch' ? otelServiceNames.daemon : otelServiceNames.cli

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

const resourceAttributeValue = (input: string | undefined, key: string): string | undefined =>
  input
    ?.split(',')
    .map((entry) => entry.split('='))
    .find((entry) => entry.length === 2 && entry[0]?.trim() === key)?.[1]
    ?.trim()

export const otelCorrelationSpanAttributes = (input: {
  readonly agentRunId?: string | undefined
  readonly resourceAttributes?: string | undefined
}): Record<string, SpanAttributeValue> =>
  spanAttributes({
    [spanAttr.agentIterationId]:
      input.agentRunId ??
      resourceAttributeValue(input.resourceAttributes, spanAttr.agentIterationId),
  })
