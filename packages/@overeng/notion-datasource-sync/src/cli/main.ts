#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { FetchHttpClient } from '@effect/platform'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Effect, Either, Layer, Option, Redacted, Schema, Stream } from 'effect'

import {
  NOTION_API_VERSION,
  NotionConfigLive,
  NotionHttpTelemetry,
  parseNotionUuid,
  type NotionHttpTelemetryEvent,
} from '@overeng/notion-effect-client'
import {
  NmdStateStore,
  NmdStateStoreLive,
  NotionMdGateway,
  NotionMdGatewayLive,
} from '@overeng/notion-md'
import { resolveCliVersion } from '@overeng/utils/node/cli-version'
import { makeOtelCliLayer } from '@overeng/utils/node/otel'

import { makeUnsupportedPageBodySyncPort } from '../body/adapter.ts'
import {
  makeNotionMdMaterializingLocalWorkspacePort,
  makeNotionMdPageBodySyncPort,
} from '../body/notion-md.ts'
import { CanonicalPropertyValue, QueryContract } from '../core/commands.ts'
import {
  AbsolutePath,
  DatabaseId,
  DataSourceId,
  Hash,
  PageId,
  PropertyId,
  type CapabilityName,
} from '../core/domain.ts'
import type {
  BodySyncError,
  LocalStorageError,
  LocalStoreError,
  NotionGatewayError,
} from '../core/errors.ts'
import { SyncEventId, SyncRootId, type SyncRootId as SyncRootIdType } from '../core/events.ts'
import {
  LocalWorkspacePort,
  NotionDataSourceGateway,
  PageBodySyncPort,
  type LocalWorkspacePortShape,
  type NotionDataSourceGatewayShape,
  type PageBodySyncPortShape,
} from '../core/ports.ts'
import { SyncProgress, type SyncProgressEvent } from '../core/progress.ts'
import { readUserActionSurface, type UserActionSurface } from '../core/result-envelope.ts'
import type { SignalInboxStatus } from '../core/signals.ts'
import { readOneShotSyncStatus, type OneShotSyncStatus } from '../core/status.ts'
import {
  makeWatchDaemonWakeNotifier,
  runWatchDaemon,
  type WatchDaemonMode,
  type WatchDaemonRunResult,
  type WatchDaemonWakeNotifier,
} from '../daemon/watch.ts'
import {
  exportReplica,
  ReplicaExportError,
  type ReplicaExportFormat,
  type ReplicaExportResult,
} from '../export/replica-export.ts'
import {
  allGatewayCapabilities,
  makeGatewayError,
  makeNotionApiContract,
  type GatewayOperation,
} from '../gateway/gateway.ts'
import {
  makeNotionEffectClientGatewayClient,
  makeNotionDataSourceGatewayFromClient,
  NotionDataSourceGatewayLive,
  type NotionGatewayClient,
} from '../gateway/notion.ts'
import { filesystemLocalWorkspacePortLayer } from '../local/workspace.ts'
import {
  otelServiceNameForCliArgv,
  otelCorrelationSpanAttributes,
  otelServiceNames,
  processRoleForCliCommand,
  shortSpanId,
  spanAttr,
  spanAttributes,
  spanLabel,
  spanNames,
  statusSpanAttributes,
} from '../observability/observability.ts'
import {
  forgetPageCommand,
  listUserCommandSurface,
  resolveConflictCommand,
  restorePageCommand,
  type ConflictResolutionChoice,
  type UserCommandResultEnvelope,
} from '../planner/user-commands.ts'
import {
  applyReplicaConflictResolutions,
  projectReplicaFromSyncStore,
  readPendingReplicaChanges,
  replicaChangesToPlannerIntents,
  settleReplicaChangesAfterSync,
} from '../replica/replica.ts'
import {
  type CompactionDecision,
  openNotionSyncStore,
  type NotionSyncStore,
  type WorkspaceBindingRow,
} from '../store/store.ts'
import { type SchemaPropertyObservation } from '../sync/observation.ts'
import {
  establishFromNotion,
  initOneShotSync,
  pullOneShotSync,
  pushOneShotSync,
  syncOneShot,
  type EstablishFromNotionResult,
  type OneShotPullResult,
  type OneShotPushResult,
  type OneShotSyncResult,
} from '../sync/sync.ts'
import {
  startNotionWebhookReceiver,
  type NotionWebhookReceiverHandle,
  type NotionWebhookReceiverStatus,
} from '../webhook/receiver.ts'
import {
  makeManualWebhookRelayProvider,
  makeTailscaleFunnelProvider,
  type TailscaleProcessRunner,
  type WebhookRelayExposure,
} from '../webhook/tailscale.ts'
import { renderDatasourceSyncCompletions, type CompletionShell } from './effect-command.ts'

const buildStamp = '__CLI_BUILD_STAMP__'
const cliVersion = resolveCliVersion({
  baseVersion: '0.1.0',
  buildStamp,
})

const remoteObservationContext = (context: CliContext) => ({
  ...(context.requiredCapabilities === undefined
    ? {}
    : { requiredCapabilities: context.requiredCapabilities }),
  ...(context.materializeBodies === undefined
    ? {}
    : { materializeBodies: context.materializeBodies }),
})

/**
 * Tagged union of all commands the CLI accepts.
 *
 * Each variant carries only the flags that are meaningful for that sub-command.
 * Use `parseCliCommand` to decode raw `argv` into this type.
 */
export type CliCommand =
  | {
      readonly _tag: 'init'
      readonly dataSourceId: typeof DataSourceId.Type
      readonly workspaceRoot: typeof AbsolutePath.Type
      readonly dryRun?: boolean
    }
  | { readonly _tag: 'pull' }
  | { readonly _tag: 'push'; readonly dryRun?: boolean }
  | {
      readonly _tag: 'sync'
      readonly workspaceRoot?: typeof AbsolutePath.Type
      readonly dryRun?: boolean
      readonly watch?: boolean
      readonly statePath?: string
      readonly maxCycles?: number
      readonly mode?: WatchDaemonMode
      readonly webhook?: 'none' | 'tailscale' | 'manual'
      readonly webhookRequired?: boolean
      readonly nonInteractive?: boolean
    }
  | {
      readonly _tag: 'sync-from-notion'
      readonly dataSourceId: typeof DataSourceId.Type
      readonly remoteRef: NotionRemoteRef
      readonly workspaceRoot: typeof AbsolutePath.Type
      readonly dryRun?: boolean
      readonly limit?: number
    }
  | {
      readonly _tag: 'export'
      readonly outputPath: typeof AbsolutePath.Type
      readonly workspaceRoot?: typeof AbsolutePath.Type
      readonly fromNotion?: {
        readonly dataSourceId: typeof DataSourceId.Type
        readonly remoteRef: NotionRemoteRef
      }
      readonly format: ReplicaExportFormat
      readonly requireClean?: boolean
    }
  | { readonly _tag: 'status'; readonly workspaceRoot?: typeof AbsolutePath.Type }
  | { readonly _tag: 'conflicts-list' }
  | {
      readonly _tag: 'conflicts-resolve'
      readonly conflictId: typeof SyncEventId.Type
      readonly choice: ConflictResolutionChoice
      readonly dryRun?: boolean
    }
  | {
      readonly _tag: 'forget'
      readonly pageId: typeof PageId.Type
      readonly dryRun?: boolean
    }
  | {
      readonly _tag: 'restore'
      readonly pageId: typeof PageId.Type
      readonly dryRun?: boolean
    }
  | { readonly _tag: 'migrate-store'; readonly dryRun?: boolean }
  | { readonly _tag: 'migrate-schema'; readonly dryRun?: boolean }
  | { readonly _tag: 'repair'; readonly dryRun?: boolean }
  | { readonly _tag: 'doctor' }

/**
 * Resolved runtime context shared across all CLI command handlers.
 *
 * Produced by `parseCliContext` from `argv`; holds the open sync store, root / data-source IDs,
 * workspace root, query contract, schema properties, and optional tuning knobs.
 */
export type CliContext = {
  readonly store: NotionSyncStore
  readonly storePath?: string
  readonly rootId: SyncRootIdType
  readonly dataSourceId: typeof DataSourceId.Type
  readonly workspaceRoot: typeof AbsolutePath.Type
  readonly queryContract: QueryContract
  readonly schemaProperties?: ReadonlyArray<SchemaPropertyObservation>
  readonly requiredCapabilities?: ReadonlyArray<CapabilityName>
  readonly materializeBodies?: boolean
  readonly rowLimit?: number
  readonly maxExecutorSteps?: number
  readonly leaseToken?: string
  readonly leaseDurationMs?: number
  readonly now?: () => Date
  readonly tailscaleProcessRunner?: TailscaleProcessRunner
  readonly webhookReceiverHostname?: string
  readonly webhookReceiverPort?: number
  readonly webhookReceiverPath?: string
  readonly webhookReceiverStarted?: (status: NotionWebhookReceiverStatus) => void
}

/** Environment variables read by `makeCliRuntimeLayer` to obtain the Notion API token. */
export type CliRuntimeEnv = {
  readonly NOTION_API_TOKEN?: string
  readonly NOTION_TOKEN?: string
}

/**
 * Dependency injection overrides for the CLI runtime layer.
 *
 * Allows callers (library consumers, tests) to substitute custom gateway, body-sync,
 * or workspace implementations instead of the default live/filesystem adapters.
 */
export type CliRuntimeOptions = {
  readonly env?: CliRuntimeEnv
  readonly gateway?: NotionDataSourceGatewayShape
  readonly gatewayClient?: NotionGatewayClient
  readonly body?: PageBodySyncPortShape
  readonly workspace?: LocalWorkspacePortShape
}

const normalizeAbsolutePath = (value: string): typeof AbsolutePath.Type =>
  decode({ schema: AbsolutePath, value: isAbsolute(value) === true ? value : resolve(value) })

const defaultSqlitePath = ({
  workspaceRoot,
  databaseId,
}: {
  readonly workspaceRoot: typeof AbsolutePath.Type
  readonly databaseId: string
}): typeof AbsolutePath.Type =>
  decode({
    schema: AbsolutePath,
    value: join(workspaceRoot, `${databaseId}.sqlite`),
  })

const projectReplicaIfWritable = ({
  context,
  dryRun,
}: {
  readonly context: CliContext
  readonly dryRun?: boolean
}): void => {
  if (dryRun === true || context.storePath === undefined || context.storePath === ':memory:') return
  projectReplicaFromSyncStore({
    syncStorePath: context.storePath,
    replicaPath: context.storePath,
    rootId: context.rootId,
  })
}

const statusWithReplicaPending = ({
  context,
  status,
}: {
  readonly context: CliContext
  readonly status: OneShotSyncStatus
}): OneShotSyncStatus => {
  if (
    context.storePath === undefined ||
    context.storePath === ':memory:' ||
    existsSync(context.storePath) === false
  ) {
    return status
  }

  const db = new DatabaseSync(context.storePath, { readOnly: true })
  try {
    const row = db
      .prepare(
        `SELECT pending_local_changes, conflicts_open
         FROM sync_status
         LIMIT 1`,
      )
      .get() as
      | {
          readonly pending_local_changes: number | bigint
          readonly conflicts_open: number | bigint
        }
      | undefined
    if (row === undefined) return status

    const pending = status.counts.pending + Number(row.pending_local_changes)
    const conflict = status.counts.conflict + Number(row.conflicts_open)
    const state: OneShotSyncStatus['state'] =
      conflict > 0
        ? 'conflict'
        : status.counts.blocked > 0
          ? 'blocked'
          : pending > 0
            ? 'pending'
            : 'clean'

    return {
      ...status,
      state,
      counts: {
        ...status.counts,
        clean: state === 'clean' ? 1 : 0,
        pending,
        conflict,
      },
    }
  } finally {
    db.close()
  }
}

const rootIdForDataSource = (dataSourceId: typeof DataSourceId.Type): SyncRootIdType =>
  decode({ schema: SyncRootId, value: `data-source:${dataSourceId}` })

const fullReplicaQueryContract = (): QueryContract =>
  decode({
    schema: QueryContract,
    value: {
      _tag: 'QueryContract',
      apiVersion: NOTION_API_VERSION,
      filter: null,
      sorts: [],
      pageSize: 100,
      highWatermark: null,
      membershipScope: 'all-data-source-rows',
    },
  })

/** Tagged reference to a Notion entity used as the adoption source — either a Notion data source or a Notion database that owns one. */
export type NotionRemoteRef =
  | {
      readonly _tag: 'data-source'
      readonly dataSourceId: typeof DataSourceId.Type
      readonly sourceDatabaseId?: string
    }
  | { readonly _tag: 'database'; readonly databaseId: string }

const parseNotionDataSourceRef = (value: string): typeof DataSourceId.Type => {
  return decode({ schema: DataSourceId, value: parseNotionUuid(value) ?? value })
}

const notionUrlKind = (value: string): 'data-source' | 'database' | undefined => {
  if (/^https?:\/\//iu.test(value) === false) return undefined

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }

  const pathname = url.pathname.toLowerCase()
  const searchParams = new Set([...url.searchParams.keys()].map((key) => key.toLowerCase()))
  if (
    pathname.includes('/data_sources/') === true ||
    pathname.includes('/data-source/') === true ||
    pathname.includes('/datasources/') === true ||
    searchParams.has('data_source') === true ||
    searchParams.has('data_source_id') === true
  ) {
    return 'data-source'
  }
  if (
    pathname.includes('/databases/') === true ||
    url.hostname.toLowerCase().endsWith('notion.so') === true
  ) {
    return 'database'
  }
  return undefined
}

const parseNotionRemoteRef = (value: string): NotionRemoteRef => {
  const id = parseNotionDataSourceRef(value)
  if (notionUrlKind(value) === 'database') {
    return { _tag: 'database', databaseId: id }
  }
  return { _tag: 'data-source', dataSourceId: id }
}

/** Aggregated health check result from the `doctor` command: sync status, compaction decision, and user-action surface. */
export type DoctorResult = {
  readonly _tag: 'DoctorResult'
  readonly clean: boolean
  readonly status: OneShotSyncStatus
  readonly compaction: CompactionDecision
  readonly surface: UserActionSurface
}

/** Runtime webhook health reported by `sync --watch`. */
export type SyncWatchWebhookStatus =
  | {
      readonly _tag: 'WebhookDisabled'
      readonly provider: 'none'
      readonly signals: SignalInboxStatus
    }
  | {
      readonly _tag: 'WebhookManualStatus'
      readonly provider: 'manual'
      readonly state: 'running'
      readonly message: string
      readonly receiver: NotionWebhookReceiverStatus
      readonly exposure: WebhookRelayExposure
      readonly signals: SignalInboxStatus
    }
  | {
      readonly _tag: 'WebhookTailscaleStatus'
      readonly provider: 'tailscale'
      readonly state: 'running' | 'degraded'
      readonly message: string
      readonly receiver: NotionWebhookReceiverStatus
      readonly exposure?: WebhookRelayExposure
      readonly signals: SignalInboxStatus
    }

/** Result envelope returned after a bounded `sync --watch` daemon run. */
export type SyncWatchRunResult = {
  readonly _tag: 'SyncWatchRunResult'
  readonly webhook: SyncWatchWebhookStatus
  readonly daemon: WatchDaemonRunResult
}

type ActiveWatchWebhook = {
  readonly status: SyncWatchWebhookStatus
  readonly wakeNotifier: WatchDaemonWakeNotifier | undefined
  readonly close: () => Promise<void>
}

/**
 * Successful JSON output envelope written to `stdout` by every CLI command.
 *
 * Always carries the current sync `status` and `surface` so consumers can inspect
 * workspace health without a separate `status` call. `ok` is `true` iff the sync
 * state is `clean`.
 */
export type CliResultEnvelope<TResult = unknown> = {
  readonly _tag: 'CliResultEnvelope'
  readonly version: 'v1'
  readonly command: CliCommand['_tag']
  readonly ok: boolean
  readonly rootId: SyncRootIdType
  readonly status: OneShotSyncStatus
  readonly surface: UserActionSurface
  readonly result: TResult
}

/** Error JSON envelope written to `stderr` when a CLI command fails, carrying a `_tag` and `message`. */
export type CliErrorEnvelope = {
  readonly _tag: 'CliErrorEnvelope'
  readonly version: 'v1'
  readonly ok: false
  readonly error: {
    readonly _tag: string
    readonly message: string
  }
}

/** Thrown during argument parsing when a required flag is missing, invalid, or unsupported. */
export class CliArgumentError extends Schema.TaggedError<CliArgumentError>()('CliArgumentError', {
  message: Schema.String,
}) {}

/** Raised when the user invokes a recognized but not-yet-implemented command (e.g. `migrate-store`, `repair`). */
export class CliUnsupportedCommandError extends Schema.TaggedError<CliUnsupportedCommandError>()(
  'CliUnsupportedCommandError',
  {
    command: Schema.String,
    message: Schema.String,
  },
) {}

const makeUnsupportedCommandError = (command: CliCommand['_tag']): CliUnsupportedCommandError =>
  new CliUnsupportedCommandError({
    command,
    message: `${command} is not implemented yet; refusing to run without an explicit implementation.`,
  })

const isUnsupportedCommand = (command: CliCommand): boolean =>
  command._tag === 'migrate-store' || command._tag === 'migrate-schema' || command._tag === 'repair'

const isWatchCommand = (command: CliCommand): boolean =>
  command._tag === 'sync' && command.watch === true

/** Returns the OTel service name for the given parsed command — `sync --watch` maps to the daemon service, all others to the CLI service. */
export const serviceNameForCliCommand = (command: CliCommand): string =>
  isWatchCommand(command) === true ? otelServiceNames.daemon : otelServiceNames.cli

const SchemaPropertyObservationJson = Schema.Struct({
  propertyId: PropertyId,
  name: Schema.optional(Schema.NonEmptyTrimmedString),
  type: Schema.optional(Schema.NonEmptyTrimmedString),
  configHash: Hash,
  writeClass: Schema.Literal('writable', 'computed', 'unsupported'),
  configJson: Schema.optional(Schema.String),
}).annotations({ identifier: 'NotionDatasourceSync.Cli.SchemaPropertyObservationJson' })

const capabilityNames = new Set<CapabilityName>(allGatewayCapabilities)

const decode = <TSchema extends Schema.Schema.AnyNoContext>({
  schema,
  value,
}: {
  readonly schema: TSchema
  readonly value: unknown
}): typeof schema.Type => Schema.decodeUnknownSync(schema)(value)

const decodeJson = <TSchema extends Schema.Schema.AnyNoContext>({
  schema,
  value,
}: {
  readonly schema: TSchema
  readonly value: string
}): typeof schema.Type =>
  Schema.decodeUnknownSync(schema)(
    Schema.decodeUnknownSync(Schema.parseJson(Schema.Unknown))(value),
  )

const withOptionalRuntimeOptions = (context: CliContext) => ({
  ...(context.maxExecutorSteps === undefined ? {} : { maxExecutorSteps: context.maxExecutorSteps }),
  ...(context.leaseToken === undefined ? {} : { leaseToken: context.leaseToken }),
  ...(context.leaseDurationMs === undefined ? {} : { leaseDurationMs: context.leaseDurationMs }),
})

const withOptionalCommandOptions = ({
  command,
  context,
}: {
  readonly command: { readonly dryRun?: boolean }
  readonly context: CliContext
}) => ({
  ...(command.dryRun === undefined ? {} : { dryRun: command.dryRun }),
  ...(context.now === undefined ? {} : { now: context.now }),
})

const withOptionalObservationLimit = (context: CliContext): { readonly rowLimit?: number } =>
  context.rowLimit === undefined ? {} : { rowLimit: context.rowLimit }

const defaultWatchStatePath = (context: CliContext): string =>
  context.storePath === undefined || context.storePath === ':memory:'
    ? join(context.workspaceRoot, '.notion-datasource-sync', 'watch.json')
    : `${context.storePath}.watch.json`

const defaultWebhookReceiverPort = 39231
const defaultWebhookReceiverPathPrefix = '/notion-datasource-sync/webhook/notion'

const makeDefaultWebhookReceiverPath = (): string =>
  `${defaultWebhookReceiverPathPrefix}/${randomUUID()}`

// oxlint-disable-next-line overeng/named-args -- implements TailscaleProcessRunner callback shape.
const defaultTailscaleProcessRunner: TailscaleProcessRunner = (command, args) =>
  new Promise((resolveProcess) => {
    execFile(command, [...args], { timeout: 5_000 }, (error, stdout, stderr) => {
      if (error === null) {
        resolveProcess({ exitCode: 0, stdout, stderr })
        return
      }
      const maybeExitCode =
        typeof error === 'object' && 'code' in error && typeof error.code === 'number'
          ? error.code
          : 1
      resolveProcess({
        exitCode: maybeExitCode,
        stdout,
        stderr,
      })
    })
  })

const signalStatus = (context: CliContext): SignalInboxStatus =>
  context.store.readSignalStatus(context.rootId)

const closeWebhookResources = async ({
  receiver,
  providerStop,
}: {
  readonly receiver: NotionWebhookReceiverHandle | undefined
  readonly providerStop: (() => Promise<void>) | undefined
}) => {
  try {
    await providerStop?.()
  } finally {
    await receiver?.close()
  }
}

const setupWatchWebhook = ({
  command,
  context,
}: {
  readonly command: Extract<CliCommand, { readonly _tag: 'sync' }>
  readonly context: CliContext
}): Effect.Effect<ActiveWatchWebhook, CliArgumentError> => {
  const provider = command.webhook ?? 'none'
  if (provider === 'none') {
    if (command.webhookRequired === true) {
      return Effect.fail(
        new CliArgumentError({
          message:
            'sync --watch --webhook-required requires --webhook tailscale or --webhook manual',
        }),
      )
    }
    return Effect.succeed({
      status: {
        _tag: 'WebhookDisabled',
        provider: 'none',
        signals: signalStatus(context),
      },
      wakeNotifier: undefined,
      close: async () => {},
    })
  }

  return Effect.tryPromise({
    try: async () => {
      const wakeNotifier = makeWatchDaemonWakeNotifier()
      const receiver = await startNotionWebhookReceiver({
        rootId: context.rootId,
        store: context.store,
        ...(context.webhookReceiverHostname === undefined
          ? {}
          : { hostname: context.webhookReceiverHostname }),
        port: context.webhookReceiverPort ?? defaultWebhookReceiverPort,
        path: context.webhookReceiverPath ?? makeDefaultWebhookReceiverPath(),
        onSignalEnqueued: () => wakeNotifier.wake(),
      })
      context.webhookReceiverStarted?.(receiver)

      if (provider === 'manual') {
        const manual = makeManualWebhookRelayProvider({
          publicUrl: receiver.url,
          localTarget: `${receiver.hostname}:${receiver.port.toString()}`,
          path: receiver.path,
        })
        const exposure = await manual.start()
        return {
          status: {
            _tag: 'WebhookManualStatus',
            provider: 'manual',
            state: 'running',
            message:
              'Manual webhook receiver is running locally; configure an external relay to deliver Notion webhooks to the callback URL.',
            receiver,
            exposure,
            signals: signalStatus(context),
          },
          wakeNotifier,
          close: () => closeWebhookResources({ receiver, providerStop: manual.stop }),
        } satisfies ActiveWatchWebhook
      }

      const tailscale = makeTailscaleFunnelProvider({
        localPort: receiver.port,
        path: receiver.path,
        run: context.tailscaleProcessRunner ?? defaultTailscaleProcessRunner,
      })
      let shouldStopTailscale = false
      try {
        const exposure = await tailscale.start()
        shouldStopTailscale = true
        return {
          status: {
            _tag: 'WebhookTailscaleStatus',
            provider: 'tailscale',
            state: 'running',
            message:
              'Tailscale Funnel is exposing the local webhook receiver; webhook hints still require reconciliation before planning.',
            receiver,
            exposure,
            signals: signalStatus(context),
          },
          wakeNotifier,
          close: () =>
            closeWebhookResources({
              receiver,
              providerStop: shouldStopTailscale === true ? tailscale.stop : undefined,
            }),
        } satisfies ActiveWatchWebhook
      } catch (cause) {
        if (cause instanceof CliArgumentError) throw cause
        if (command.webhookRequired === true) {
          await closeWebhookResources({ receiver, providerStop: undefined })
          throw new CliArgumentError({
            message: 'sync --watch --webhook-required could not start Tailscale Funnel',
          })
        }
        return {
          status: {
            _tag: 'WebhookTailscaleStatus',
            provider: 'tailscale',
            state: 'degraded',
            message:
              'Local webhook receiver is running, but Tailscale Funnel could not be started; continuing with polling reconciliation.',
            receiver,
            signals: signalStatus(context),
          },
          wakeNotifier,
          close: () => closeWebhookResources({ receiver, providerStop: undefined }),
        } satisfies ActiveWatchWebhook
      }
    },
    catch: (cause) =>
      cause instanceof CliArgumentError
        ? cause
        : new CliArgumentError({
            message: 'Unable to initialize sync --watch webhook status',
          }),
  })
}

const envelope = <TResult>({
  command,
  context,
  result,
}: {
  readonly command: CliCommand['_tag']
  readonly context: CliContext
  readonly result: TResult
}): CliResultEnvelope<TResult> => {
  const status = readOneShotSyncStatus({ store: context.store, rootId: context.rootId })
  return {
    _tag: 'CliResultEnvelope',
    version: 'v1',
    command,
    ok: status.state === 'clean',
    rootId: context.rootId,
    status,
    surface: readUserActionSurface({ store: context.store, rootId: context.rootId }),
    result,
  }
}

type CliCommandRuntimeResult = CliResultEnvelope<
  | OneShotSyncStatus
  | EstablishFromNotionResult
  | OneShotPullResult
  | OneShotPushResult
  | OneShotSyncResult
  | WatchDaemonRunResult
  | SyncWatchRunResult
  | UserCommandResultEnvelope
  | ReplicaExportResult
  | DoctorResult
>

type CliCommandRuntimeError =
  | LocalStoreError
  | NotionGatewayError
  | BodySyncError
  | LocalStorageError
  | ReplicaExportError
  | CliArgumentError
  | CliUnsupportedCommandError

const runCliCommandEffect = ({
  command,
  context,
}: {
  readonly command: CliCommand
  readonly context: CliContext
}): Effect.Effect<
  CliCommandRuntimeResult,
  CliCommandRuntimeError,
  NotionDataSourceGateway | PageBodySyncPort | LocalWorkspacePort
> => {
  switch (command._tag) {
    case 'init':
      return Effect.sync(() =>
        envelope({
          command: command._tag,
          context,
          result: initOneShotSync({
            store: context.store,
            rootId: context.rootId,
            dataSourceId: command.dataSourceId,
            workspaceRoot: command.workspaceRoot,
            ...withOptionalCommandOptions({ command, context }),
          }),
        }),
      ).pipe(
        Effect.withSpan(spanNames.syncInit, {
          attributes: spanAttributes({
            [spanAttr.spanLabel]: spanLabel('init', shortSpanId(context.rootId)),
            [spanAttr.processRole]: processRoleForCliCommand(command._tag),
            [spanAttr.operation]: 'init',
            [spanAttr.rootId]: context.rootId,
            [spanAttr.dataSourceId]: command.dataSourceId,
            [spanAttr.dryRun]: command.dryRun === true,
          }),
        }),
      )
    case 'pull':
      return pullOneShotSync({
        ...context,
        ...remoteObservationContext(context),
        ...withOptionalObservationLimit(context),
      }).pipe(
        Effect.tap(() => Effect.sync(() => projectReplicaIfWritable({ context }))),
        Effect.map((result) => envelope({ command: command._tag, context, result })),
      )
    case 'sync-from-notion':
      return establishFromNotion({
        ...context,
        ...remoteObservationContext(context),
        ...withOptionalObservationLimit(context),
        dataSourceId: command.dataSourceId,
        workspaceRoot: command.workspaceRoot,
        ...withOptionalCommandOptions({ command, context }),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (command.dryRun === true) return
            projectReplicaIfWritable({
              context,
              ...(command.dryRun === undefined ? {} : { dryRun: command.dryRun }),
            })
          }),
        ),
        Effect.map((result) => envelope({ command: command._tag, context, result })),
      )
    case 'push':
      return Effect.sync(() => {
        const replicaPath = context.storePath
        if (replicaPath === undefined)
          return { changes: [] as const, intents: [] as const, replicaPath: ':memory:' }
        if (existsSync(replicaPath) === false)
          return { changes: [] as const, intents: [] as const, replicaPath }
        const changes = readPendingReplicaChanges(replicaPath)
        applyReplicaConflictResolutions({
          changes,
          replicaPath,
          store: context.store,
          rootId: context.rootId,
          ...(command.dryRun === undefined ? {} : { dryRun: command.dryRun }),
        })
        const intents = replicaChangesToPlannerIntents({
          changes: changes.filter((change) => change.kind !== 'conflict_resolution'),
          replicaPath,
          ...(command.dryRun === undefined ? {} : { dryRun: command.dryRun }),
        })
        return { changes, intents, replicaPath }
      }).pipe(
        Effect.flatMap(({ changes, intents, replicaPath }) =>
          pushOneShotSync({
            ...context,
            ...withOptionalRuntimeOptions(context),
            ...withOptionalCommandOptions({ command, context }),
            localIntents: intents,
          }).pipe(
            Effect.tap((result) =>
              Effect.sync(() =>
                settleReplicaChangesAfterSync({
                  changes,
                  replicaPath,
                  store: context.store,
                  rootId: context.rootId,
                  decisions: result.plan.decisions,
                  ...(command.dryRun === undefined ? {} : { dryRun: command.dryRun }),
                }),
              ),
            ),
          ),
        ),
        Effect.tap(() =>
          Effect.sync(() =>
            projectReplicaIfWritable({
              context,
              ...(command.dryRun === undefined ? {} : { dryRun: command.dryRun }),
            }),
          ),
        ),
        Effect.map((result) => envelope({ command: command._tag, context, result })),
      )
    case 'sync':
      if (command.watch === true) {
        if (command.dryRun === true) {
          return Effect.fail(
            new CliArgumentError({
              message:
                'sync --watch does not support --dry-run; run sync --dry-run for a one-shot dry run',
            }),
          )
        }
        return setupWatchWebhook({ command, context }).pipe(
          Effect.flatMap((webhook) =>
            runWatchDaemon({
              ...context,
              ...remoteObservationContext(context),
              ...withOptionalObservationLimit(context),
              statePath: command.statePath ?? defaultWatchStatePath(context),
              ...(command.maxCycles === undefined ? {} : { maxCycles: command.maxCycles }),
              ...(command.mode === undefined ? {} : { mode: command.mode }),
              ...(webhook.wakeNotifier === undefined ? {} : { wakeNotifier: webhook.wakeNotifier }),
              ...withOptionalRuntimeOptions(context),
            }).pipe(
              Effect.map((daemon) =>
                envelope({
                  command: command._tag,
                  context,
                  result:
                    command.webhook === undefined || command.webhook === 'none'
                      ? daemon
                      : ({
                          _tag: 'SyncWatchRunResult',
                          webhook: webhook.status,
                          daemon,
                        } satisfies SyncWatchRunResult),
                }),
              ),
              Effect.ensuring(
                Effect.tryPromise({
                  try: webhook.close,
                  catch: (cause) =>
                    new CliArgumentError({
                      message: `Unable to stop sync --watch webhook resources: ${String(cause)}`,
                    }),
                }).pipe(Effect.ignore),
              ),
            ),
          ),
        )
      }
      if (command.workspaceRoot !== undefined) {
        const binding = readOneShotSyncStatus({
          store: context.store,
          rootId: context.rootId,
        }).binding
        if (binding === undefined) {
          return Effect.fail(
            new CliArgumentError({
              message: `Workspace ${command.workspaceRoot} has no recorded binding; establish it with sync --from-notion before running sync <workspace-root>`,
            }),
          )
        }
        if (
          binding.dataSourceId !== context.dataSourceId ||
          binding.workspaceRoot !== context.workspaceRoot
        ) {
          return Effect.fail(
            new CliArgumentError({
              message: `Workspace config/store binding mismatch for ${command.workspaceRoot}; refusing to sync`,
            }),
          )
        }
      }
      return Effect.sync(() => {
        const replicaPath = context.storePath
        if (replicaPath === undefined)
          return { changes: [] as const, intents: [] as const, replicaPath: ':memory:' }
        if (existsSync(replicaPath) === false)
          return { changes: [] as const, intents: [] as const, replicaPath }
        const changes = readPendingReplicaChanges(replicaPath)
        applyReplicaConflictResolutions({
          changes,
          replicaPath,
          store: context.store,
          rootId: context.rootId,
          ...(command.dryRun === undefined ? {} : { dryRun: command.dryRun }),
        })
        const intents = replicaChangesToPlannerIntents({
          changes: changes.filter((change) => change.kind !== 'conflict_resolution'),
          replicaPath,
          ...(command.dryRun === undefined ? {} : { dryRun: command.dryRun }),
        })
        return { changes, intents, replicaPath }
      }).pipe(
        Effect.flatMap(({ changes, intents, replicaPath }) =>
          syncOneShot({
            ...context,
            ...remoteObservationContext(context),
            ...withOptionalObservationLimit(context),
            ...withOptionalRuntimeOptions(context),
            ...withOptionalCommandOptions({ command, context }),
            localIntents: intents,
          }).pipe(
            Effect.tap((result) =>
              Effect.sync(() =>
                settleReplicaChangesAfterSync({
                  changes,
                  replicaPath,
                  store: context.store,
                  rootId: context.rootId,
                  decisions: result.push.plan.decisions,
                  ...(command.dryRun === undefined ? {} : { dryRun: command.dryRun }),
                }),
              ),
            ),
          ),
        ),
        Effect.tap(() =>
          Effect.sync(() =>
            projectReplicaIfWritable({
              context,
              ...(command.dryRun === undefined ? {} : { dryRun: command.dryRun }),
            }),
          ),
        ),
        Effect.map((result) => envelope({ command: command._tag, context, result })),
      )
    case 'export': {
      const refresh =
        command.fromNotion === undefined
          ? Effect.void
          : context.store.readWorkspaceBinding(context.rootId) === undefined
            ? establishFromNotion({
                ...context,
                ...remoteObservationContext(context),
                ...withOptionalObservationLimit(context),
                dataSourceId: command.fromNotion.dataSourceId,
                workspaceRoot: context.workspaceRoot,
              }).pipe(Effect.asVoid)
            : pullOneShotSync({
                ...context,
                ...remoteObservationContext(context),
                ...withOptionalObservationLimit(context),
              }).pipe(Effect.asVoid)

      return refresh.pipe(
        Effect.tap(() => Effect.sync(() => projectReplicaIfWritable({ context }))),
        Effect.flatMap(() =>
          Effect.try({
            try: () => {
              if (context.storePath === undefined || context.storePath === ':memory:') {
                throw new ReplicaExportError('export requires a file-backed SQLite replica')
              }
              return exportReplica({
                replicaPath: context.storePath,
                outputPath: command.outputPath,
                format: command.format,
                ...(command.requireClean === undefined
                  ? {}
                  : { requireClean: command.requireClean }),
              })
            },
            catch: (cause) =>
              cause instanceof ReplicaExportError ? cause : new ReplicaExportError(String(cause)),
          }),
        ),
        Effect.map((result) => envelope({ command: command._tag, context, result })),
      )
    }
    case 'status':
      if (command.workspaceRoot !== undefined) {
        const binding = readOneShotSyncStatus({
          store: context.store,
          rootId: context.rootId,
        }).binding
        if (
          binding !== undefined &&
          (binding.dataSourceId !== context.dataSourceId ||
            binding.workspaceRoot !== context.workspaceRoot)
        ) {
          return Effect.fail(
            new CliArgumentError({
              message: `Workspace config/store binding mismatch for ${command.workspaceRoot}; refusing to read status`,
            }),
          )
        }
      }
      return Effect.sync(() =>
        envelope({
          command: command._tag,
          context,
          result: statusWithReplicaPending({
            context,
            status: readOneShotSyncStatus({ store: context.store, rootId: context.rootId }),
          }),
        }),
      )
    case 'conflicts-list':
      return Effect.sync(() =>
        envelope({
          command: command._tag,
          context,
          result: listUserCommandSurface({ store: context.store, rootId: context.rootId }),
        }),
      )
    case 'conflicts-resolve':
      return Effect.sync(() =>
        envelope({
          command: command._tag,
          context,
          result: resolveConflictCommand({
            store: context.store,
            rootId: context.rootId,
            conflictId: command.conflictId,
            choice: command.choice,
            ...withOptionalCommandOptions({ command, context }),
          }),
        }),
      )
    case 'forget':
      return Effect.sync(() =>
        envelope({
          command: command._tag,
          context,
          result: forgetPageCommand({
            store: context.store,
            rootId: context.rootId,
            pageId: command.pageId,
            ...withOptionalCommandOptions({ command, context }),
          }),
        }),
      )
    case 'restore':
      return Effect.sync(() =>
        envelope({
          command: command._tag,
          context,
          result: restorePageCommand({
            store: context.store,
            rootId: context.rootId,
            pageId: command.pageId,
            ...withOptionalCommandOptions({ command, context }),
          }),
        }),
      )
    case 'migrate-store':
    case 'migrate-schema':
    case 'repair':
      return Effect.fail(makeUnsupportedCommandError(command._tag))
    case 'doctor':
      return Effect.sync(() => {
        const status = readOneShotSyncStatus({ store: context.store, rootId: context.rootId })
        const compaction = context.store.getCompactionDecision(context.rootId)
        const surface = readUserActionSurface({ store: context.store, rootId: context.rootId })
        const result: DoctorResult = {
          _tag: 'DoctorResult',
          clean:
            status.state === 'clean' &&
            compaction._tag === 'allowed' &&
            surface.conflicts.length === 0 &&
            surface.guards.length === 0 &&
            surface.tombstones.length === 0 &&
            surface.outbox.length === 0,
          status,
          compaction,
          surface,
        }
        return envelope({ command: command._tag, context, result })
      })
  }
}

/**
 * Runs a parsed `CliCommand` against the provided context under the `notion.datasource.cli` span.
 *
 * Annotates the span with correlation attributes, command identity, and final status before returning
 * a `CliResultEnvelope`. Requires `NotionDataSourceGateway`, `PageBodySyncPort`, and `LocalWorkspacePort`
 * in the Effect context.
 */
export const runCliCommand = Effect.fn(spanNames.cliCommand, {
  attributes: spanAttributes({
    [spanAttr.spanLabel]: 'command',
    [spanAttr.processRole]: 'cli',
  }),
})(
  (
    command: CliCommand,
    context: CliContext,
  ): Effect.Effect<
    CliCommandRuntimeResult,
    CliCommandRuntimeError,
    NotionDataSourceGateway | PageBodySyncPort | LocalWorkspacePort
  > =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan(
        spanAttributes({
          ...otelCorrelationSpanAttributes({
            agentRunId: process.env.OTEL_AGENT_RUN_ID,
            resourceAttributes: process.env.OTEL_RESOURCE_ATTRIBUTES,
          }),
          [spanAttr.spanLabel]: spanLabel(command._tag),
          [spanAttr.command]: command._tag,
          [spanAttr.processRole]: processRoleForCliCommand(command._tag, {
            watch: isWatchCommand(command),
          }),
          [spanAttr.rootId]: context.rootId,
          [spanAttr.dataSourceId]: context.dataSourceId,
          [spanAttr.dryRun]: 'dryRun' in command ? command.dryRun === true : undefined,
          [spanAttr.maxCycles]:
            command._tag === 'sync' && command.watch === true ? command.maxCycles : undefined,
        }),
      )
      const result = yield* runCliCommandEffect({ command, context })
      yield* Effect.annotateCurrentSpan({
        ...statusSpanAttributes(result.status),
        [spanAttr.result]: result.ok === true ? 'ok' : result.status.state,
      })
      return result
    }),
)

// JSON.stringify replacer must be (key, value) — fixed external API.
// oxlint-disable-next-line overeng/named-args
const cliJsonReplacer = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? value.toString() : value

/** Serialize a `CliResultEnvelope` to a pretty-printed JSON string with a trailing newline for stdout — BigInt values are stringified for JSON safety. */
export const renderCliResultJson = (result: CliResultEnvelope): string =>
  `${JSON.stringify(result, cliJsonReplacer, 2)}\n`

/** Serializes any thrown error into a `CliErrorEnvelope` JSON string with a trailing newline for stderr. */
export const renderCliErrorJson = (error: unknown): string => {
  const errorEnvelope: CliErrorEnvelope = {
    _tag: 'CliErrorEnvelope',
    version: 'v1',
    ok: false,
    error: {
      _tag:
        typeof error === 'object' &&
        error !== null &&
        '_tag' in error &&
        typeof error._tag === 'string'
          ? error._tag
          : error instanceof Error
            ? error.name
            : 'CliError',
      message:
        typeof error === 'object' &&
        error !== null &&
        'message' in error &&
        typeof error.message === 'string'
          ? error.message
          : String(error),
    },
  }
  return `${JSON.stringify(errorEnvelope, cliJsonReplacer, 2)}\n`
}

/** Render the top-level help text for the Node-backed `notion db` command surface. */
export const renderCliHelpText = (): string => `notion db

Notion database replica sync.

Supported runtime:
  notion db ...            Packaged Node-backed entrypoint from Nix/devenv

Commands:
  init                    Initialize a local SQLite sync store
  pull                    Pull remote Notion changes into SQLite
  push                    Push accepted local SQLite changes to Notion
  sync                    Run pull and push, or adopt from Notion with --from-notion
  export                  Export rows, schema, and sync metadata from SQLite
  status                  Print workspace sync status
  conflicts list          List unresolved conflicts
  conflicts resolve       Resolve a conflict
  forget                  Archive/forget a page locally
  restore                 Restore a forgotten page locally
  migrate store           Reserved; currently fails closed
  migrate schema          Reserved; currently fails closed
  repair                  Reserved; currently fails closed
  doctor                  Print diagnostics

Common options:
  --sqlite <path>         SQLite store path
  --root-id <id>          Sync root id
  --data-source-id <id>   Notion data source id
  --workspace-root <dir>  Local workspace root
  --output <path>         Export output path for export
  --dry-run               Validate without mutating local or remote state
  --help                  Show this help
  --version               Show build/version identity

Unsupported source/Bun execution is expected to fail closed. Use the packaged
Node-backed notion db path for replica workflows.
`

const isHelpArgv = (argv: ReadonlyArray<string>): boolean =>
  argv.length === 0 || argv.includes('--help') || argv.includes('-h')

const isVersionArgv = (argv: ReadonlyArray<string>): boolean =>
  argv.length === 1 && argv[0] === '--version'

const completionShells = new Set<CompletionShell>(['bash', 'fish', 'sh', 'zsh'])

const parseCompletionShell = (value: string | undefined): CompletionShell | undefined => {
  if (value === undefined) return undefined
  return completionShells.has(value as CompletionShell) === true
    ? (value as CompletionShell)
    : undefined
}

const completionShellFromArgv = (argv: ReadonlyArray<string>): CompletionShell | undefined => {
  const [first, second] = argv
  if (first === '--completions') return parseCompletionShell(second)
  if (first === 'completion') return parseCompletionShell(second)
  return undefined
}

const booleanFlags = new Set([
  'dry-run',
  'help',
  'no-materialize-bodies',
  'non-interactive',
  'require-clean',
  'watch',
  'webhook-required',
])

const parseFlags = (argv: ReadonlyArray<string>): Map<string, string | true> => {
  const flags = new Map<string, string | true>()
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item?.startsWith('--') !== true) continue
    const key = item.slice(2)
    if (flags.has(key) === true) {
      throw new CliArgumentError({ message: `Repeated --${key} is not supported` })
    }
    const next = argv[index + 1]
    if (booleanFlags.has(key) === false && next !== undefined && next.startsWith('--') === false) {
      flags.set(key, next)
      index += 1
    } else {
      flags.set(key, true)
    }
  }
  return flags
}

const parsePositionals = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const positionals: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item?.startsWith('--') === true) {
      const next = argv[index + 1]
      if (
        booleanFlags.has(item.slice(2)) === false &&
        next !== undefined &&
        next.startsWith('--') === false
      )
        index += 1
      continue
    }
    if (item !== undefined) positionals.push(item)
  }
  return positionals
}

const requiredFlag = ({
  flags,
  name,
}: {
  readonly flags: Map<string, string | true>
  readonly name: string
}): string => {
  const value = flags.get(name)
  if (typeof value === 'string' && value.length > 0) return value
  throw new CliArgumentError({ message: `Missing required --${name}` })
}

const optionalFlag = ({
  flags,
  name,
}: {
  readonly flags: Map<string, string | true>
  readonly name: string
}): string | undefined => {
  const value = flags.get(name)
  return typeof value === 'string' ? value : undefined
}

const positiveIntegerFlag = ({
  flags,
  name,
}: {
  readonly flags: Map<string, string | true>
  readonly name: string
}): number | undefined => {
  const value = flags.get(name)
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new CliArgumentError({ message: `Missing value for --${name}` })
  }

  if (/^[1-9][0-9]*$/.test(value) === false) {
    throw new CliArgumentError({
      message: `--${name} must be a positive integer`,
    })
  }

  const parsed = Number(value)
  if (Number.isSafeInteger(parsed) === true && parsed > 0) return parsed

  throw new CliArgumentError({
    message: `--${name} must be a positive integer`,
  })
}

const watchModeFlag = (flags: Map<string, string | true>): WatchDaemonMode | undefined => {
  const mode = optionalFlag({ flags, name: 'mode' })
  if (mode === undefined) return undefined
  switch (mode) {
    case 'development':
    case 'normal':
    case 'low-priority':
      return mode
    default:
      throw new CliArgumentError({
        message: '--mode must be one of: development, normal, low-priority',
      })
  }
}

const webhookProviderFlag = (
  flags: Map<string, string | true>,
): 'none' | 'tailscale' | 'manual' | undefined => {
  const provider = optionalFlag({ flags, name: 'webhook' })
  if (provider === undefined) {
    if (flags.has('webhook') === true) {
      throw new CliArgumentError({
        message: '--webhook must be one of: none, tailscale, manual',
      })
    }
    return undefined
  }
  switch (provider) {
    case 'none':
    case 'tailscale':
    case 'manual':
      return provider
    default:
      throw new CliArgumentError({
        message: '--webhook must be one of: none, tailscale, manual',
      })
  }
}

const optionalLimitFlag = (flags: Map<string, string | true>): number | undefined => {
  const limit = positiveIntegerFlag({ flags, name: 'limit' })
  const maxRows = positiveIntegerFlag({ flags, name: 'max-rows' })
  if (limit !== undefined && maxRows !== undefined) {
    throw new CliArgumentError({ message: 'Use only one of --limit or --max-rows' })
  }
  return limit ?? maxRows
}

const exportFormatFlag = (flags: Map<string, string | true>): ReplicaExportFormat => {
  const format = optionalFlag({ flags, name: 'format' }) ?? 'ndjson'
  switch (format) {
    case 'ndjson':
    case 'json':
      return format
    default:
      throw new CliArgumentError({ message: '--format must be one of: ndjson, json' })
  }
}

const capabilityListFlag = ({
  flags,
  name,
}: {
  readonly flags: Map<string, string | true>
  readonly name: string
}): ReadonlyArray<CapabilityName> | undefined => {
  const value = flags.get(name)
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CliArgumentError({ message: `Missing value for --${name}` })
  }

  const capabilities = value
    .split(',')
    .map((capability) => capability.trim())
    .filter((capability) => capability.length > 0)

  const invalid = capabilities.find(
    (capability) => capabilityNames.has(capability as CapabilityName) === false,
  )
  if (invalid !== undefined) {
    throw new CliArgumentError({
      message: `Unsupported capability in --${name}: ${invalid}`,
    })
  }

  return [...new Set(capabilities)] as ReadonlyArray<CapabilityName>
}

const parseChoice = (flags: Map<string, string | true>): ConflictResolutionChoice => {
  const strategy = optionalFlag({ flags, name: 'strategy' }) ?? 'keep-remote'
  switch (strategy) {
    case 'keep-remote':
      return { _tag: 'keep-remote' }
    case 'keep-local':
    case 'manual': {
      const value = decodeJson({
        schema: CanonicalPropertyValue,
        value: requiredFlag({ flags, name: 'value-json' }),
      })
      return {
        _tag: strategy,
        value,
      }
    }
    default:
      throw new CliArgumentError({
        message: `Unsupported conflict strategy: ${strategy}`,
      })
  }
}

/**
 * Parses raw `argv` into a typed `CliCommand`.
 *
 * Throws `CliArgumentError` for missing required flags, unknown commands,
 * or invalid flag values. Does not validate semantic context (store path, IDs, etc.).
 */
export const parseCliCommand = (argv: ReadonlyArray<string>): CliCommand => {
  const flags = parseFlags(argv)
  const words = parsePositionals(argv)
  const [command, subcommand] = words
  switch (command) {
    case 'init':
      return {
        _tag: 'init',
        dataSourceId: decode({
          schema: DataSourceId,
          value: requiredFlag({ flags, name: 'data-source-id' }),
        }),
        workspaceRoot: decode({
          schema: AbsolutePath,
          value: requiredFlag({ flags, name: 'workspace-root' }),
        }),
        dryRun: flags.has('dry-run'),
      }
    case 'pull':
      return { _tag: 'pull' }
    case 'push':
      return { _tag: 'push', dryRun: flags.has('dry-run') }
    case 'sync': {
      const fromNotion = optionalFlag({ flags, name: 'from-notion' })
      if (flags.has('from-notion') === true) {
        if (fromNotion === undefined) {
          throw new CliArgumentError({ message: 'Missing value for --from-notion' })
        }
        const workspace = words[1]
        if (workspace === undefined) {
          throw new CliArgumentError({
            message: 'sync --from-notion requires a workspace root positional argument',
          })
        }
        if (words.length > 2) {
          throw new CliArgumentError({
            message: 'sync --from-notion accepts exactly one workspace root positional argument',
          })
        }
        const limit = optionalLimitFlag(flags)
        if (limit !== undefined && flags.has('dry-run') === false) {
          throw new CliArgumentError({
            message: '--limit is only supported with sync --from-notion --dry-run',
          })
        }
        const remoteRef = parseNotionRemoteRef(fromNotion)
        return {
          _tag: 'sync-from-notion',
          dataSourceId:
            remoteRef._tag === 'data-source'
              ? remoteRef.dataSourceId
              : decode({ schema: DataSourceId, value: remoteRef.databaseId }),
          remoteRef,
          workspaceRoot: normalizeAbsolutePath(workspace),
          dryRun: flags.has('dry-run'),
          ...(limit === undefined ? {} : { limit }),
        }
      }
      if (words.length > 2) {
        throw new CliArgumentError({
          message: 'sync accepts at most one workspace root positional argument',
        })
      }
      const watch = flags.has('watch')
      if (watch === false) {
        if (flags.has('state') === true) {
          throw new CliArgumentError({ message: '--state is only supported with sync --watch' })
        }
        if (flags.has('max-cycles') === true) {
          throw new CliArgumentError({
            message: '--max-cycles is only supported with sync --watch',
          })
        }
        if (flags.has('mode') === true) {
          throw new CliArgumentError({ message: '--mode is only supported with sync --watch' })
        }
        if (flags.has('webhook') === true) {
          throw new CliArgumentError({ message: '--webhook is only supported with sync --watch' })
        }
        if (flags.has('webhook-required') === true) {
          throw new CliArgumentError({
            message: '--webhook-required is only supported with sync --watch',
          })
        }
        if (flags.has('non-interactive') === true) {
          throw new CliArgumentError({
            message: '--non-interactive is only supported with sync --watch',
          })
        }
      }
      const statePath = optionalFlag({ flags, name: 'state' })
      const maxCycles = positiveIntegerFlag({ flags, name: 'max-cycles' })
      const mode = watchModeFlag(flags)
      const webhook = webhookProviderFlag(flags)
      return {
        _tag: 'sync',
        ...(words[1] === undefined ? {} : { workspaceRoot: normalizeAbsolutePath(words[1]) }),
        dryRun: flags.has('dry-run'),
        ...(watch === false ? {} : { watch: true }),
        ...(statePath === undefined ? {} : { statePath }),
        ...(maxCycles === undefined ? {} : { maxCycles }),
        ...(mode === undefined ? {} : { mode }),
        ...(webhook === undefined ? {} : { webhook }),
        ...(flags.has('webhook-required') === false ? {} : { webhookRequired: true }),
        ...(flags.has('non-interactive') === false ? {} : { nonInteractive: true }),
      }
    }
    case 'export': {
      if (words.length > 2) {
        throw new CliArgumentError({
          message: 'export accepts at most one workspace root positional argument',
        })
      }
      const fromNotion = optionalFlag({ flags, name: 'from-notion' })
      if (flags.has('from-notion') === true && fromNotion === undefined) {
        throw new CliArgumentError({ message: 'Missing value for --from-notion' })
      }
      if (flags.has('dry-run') === true) {
        throw new CliArgumentError({ message: 'export does not support --dry-run' })
      }
      if (flags.has('limit') === true || flags.has('max-rows') === true) {
        throw new CliArgumentError({ message: 'export does not support --limit or --max-rows' })
      }
      const remoteRef = fromNotion === undefined ? undefined : parseNotionRemoteRef(fromNotion)
      return {
        _tag: 'export',
        outputPath: normalizeAbsolutePath(requiredFlag({ flags, name: 'output' })),
        ...(words[1] === undefined ? {} : { workspaceRoot: normalizeAbsolutePath(words[1]) }),
        ...(remoteRef === undefined
          ? {}
          : {
              fromNotion: {
                dataSourceId:
                  remoteRef._tag === 'data-source'
                    ? remoteRef.dataSourceId
                    : decode({ schema: DataSourceId, value: remoteRef.databaseId }),
                remoteRef,
              },
            }),
        format: exportFormatFlag(flags),
        ...(flags.has('require-clean') === false ? {} : { requireClean: true }),
      }
    }
    case 'status':
      if (words.length > 2) {
        throw new CliArgumentError({
          message: 'status accepts at most one workspace root positional argument',
        })
      }
      return {
        _tag: 'status',
        ...(words[1] === undefined ? {} : { workspaceRoot: normalizeAbsolutePath(words[1]) }),
      }
    case 'conflicts':
      if (subcommand === 'list') return { _tag: 'conflicts-list' }
      if (subcommand === 'resolve') {
        return {
          _tag: 'conflicts-resolve',
          conflictId: decode({
            schema: SyncEventId,
            value: requiredFlag({ flags, name: 'conflict-id' }),
          }),
          choice: parseChoice(flags),
          dryRun: flags.has('dry-run'),
        }
      }
      break
    case 'forget':
      return {
        _tag: 'forget',
        pageId: decode({ schema: PageId, value: requiredFlag({ flags, name: 'page-id' }) }),
        dryRun: flags.has('dry-run'),
      }
    case 'restore':
      return {
        _tag: 'restore',
        pageId: decode({ schema: PageId, value: requiredFlag({ flags, name: 'page-id' }) }),
        dryRun: flags.has('dry-run'),
      }
    case 'migrate':
      if (subcommand === 'store') return { _tag: 'migrate-store', dryRun: flags.has('dry-run') }
      if (subcommand === 'schema') return { _tag: 'migrate-schema', dryRun: flags.has('dry-run') }
      break
    case 'repair':
      return { _tag: 'repair', dryRun: flags.has('dry-run') }
    case 'doctor':
      return { _tag: 'doctor' }
  }
  throw new CliArgumentError({
    message:
      'Expected one of: init, pull, push, sync, export, status, conflicts list, conflicts resolve, forget, restore, migrate store, migrate schema, repair, doctor',
  })
}

type DiscoveredSelfContainedStore = {
  readonly storePath: typeof AbsolutePath.Type
  readonly rootId: SyncRootIdType
  readonly dataSourceId: typeof DataSourceId.Type
  readonly workspaceRoot: typeof AbsolutePath.Type
}

const readSelfContainedBinding = (storePath: string): WorkspaceBindingRow | undefined => {
  if (existsSync(storePath) === false) return undefined
  const db = new DatabaseSync(storePath, { readOnly: true })
  try {
    const requiredTables = [
      '_nds_sync_root',
      '_nds_sync_event',
      '_nds_workspace_binding',
      '_nds_projection_metadata',
    ] as const
    for (const table of requiredTables) {
      const row = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(table)
      if (row === undefined) return undefined
    }
    const row = db
      .prepare(
        `SELECT root_id, data_source_id, database_id, workspace_root, store_identity
         FROM _nds_workspace_binding
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get() as Record<string, unknown> | undefined
    if (row === undefined) return undefined
    return {
      rootId: decode({ schema: SyncRootId, value: row.root_id }),
      dataSourceId: decode({ schema: DataSourceId, value: row.data_source_id }),
      databaseId:
        typeof row.database_id === 'string'
          ? decode({ schema: DatabaseId, value: row.database_id })
          : undefined,
      workspaceRoot:
        typeof row.workspace_root === 'string'
          ? row.workspace_root
          : (() => {
              throw new CliArgumentError({
                message: `Corrupt datasource-sync binding in ${storePath}: missing workspace_root`,
              })
            })(),
      storeIdentity:
        typeof row.store_identity === 'string'
          ? row.store_identity
          : (() => {
              throw new CliArgumentError({
                message: `Corrupt datasource-sync binding in ${storePath}: missing store_identity`,
              })
            })(),
    }
  } finally {
    db.close()
  }
}

const validateSelfContainedSqlite = (storePath: string): void => {
  const db = new DatabaseSync(storePath, { readOnly: true })
  try {
    const requiredObjects = [
      ['table', '_nds_sync_root'],
      ['table', '_nds_sync_event'],
      ['table', '_nds_workspace_binding'],
      ['table', '_nds_projection_metadata'],
      ['table', '_nds_api_contract'],
      ['table', '_nds_body_pointer'],
      ['table', '_nds_capability'],
      ['table', '_nds_conflict'],
      ['table', '_nds_data_source'],
      ['table', '_nds_guard_block'],
      ['table', '_nds_outbox'],
      ['table', '_nds_property_shadow'],
      ['table', '_nds_query_absence'],
      ['table', '_nds_query_scan_checkpoint'],
      ['table', '_nds_row'],
      ['table', '_nds_schema_property'],
      ['table', '_nds_tombstone'],
      ['view', 'rows'],
      ['view', 'schema'],
      ['view', 'schema_properties'],
      ['view', 'changes'],
      ['view', 'conflicts'],
      ['view', 'sync_status'],
      ['trigger', '_nds_rows_update'],
      ['trigger', '_nds_rows_insert'],
      ['trigger', '_nds_rows_delete'],
    ] as const
    for (const [type, name] of requiredObjects) {
      const found = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = ? AND name = ?`)
        .get(type, name)
      if (found === undefined) {
        throw new CliArgumentError({
          message: `SQLite file ${storePath} is missing required ${type} ${name}; refusing to open`,
        })
      }
    }
    const triggerCount = db
      .prepare(`SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger'`)
      .get() as { readonly count?: unknown } | undefined
    if (typeof triggerCount?.count !== 'number' || triggerCount.count < 35) {
      throw new CliArgumentError({
        message: `SQLite file ${storePath} is missing required datasource-sync triggers; refusing to open`,
      })
    }
  } finally {
    db.close()
  }
}

const discoverSelfContainedStore = (
  workspaceRoot: typeof AbsolutePath.Type,
): DiscoveredSelfContainedStore => {
  const explicitSqliteFiles = readdirSync(workspaceRoot)
    .filter((entry) => entry.endsWith('.sqlite'))
    .map((entry) => join(workspaceRoot, entry))
  const matches = explicitSqliteFiles
    .map((storePath) => ({ storePath, binding: readSelfContainedBinding(storePath) }))
    .filter(
      (entry): entry is { readonly storePath: string; readonly binding: WorkspaceBindingRow } =>
        entry.binding !== undefined,
    )
  if (explicitSqliteFiles.length !== matches.length) {
    throw new CliArgumentError({
      message: `Found a SQLite file in ${workspaceRoot} with missing or corrupt datasource-sync internals; pass --sqlite <path> after repair`,
    })
  }
  if (matches.length !== 1) {
    throw new CliArgumentError({
      message:
        matches.length === 0
          ? `No self-contained datasource-sync SQLite file found in ${workspaceRoot}; run sync --from-notion <database-url> ${workspaceRoot}`
          : `Multiple datasource-sync SQLite files found in ${workspaceRoot}; pass --sqlite <path>`,
    })
  }
  const { storePath, binding } = matches[0]!
  if (binding.workspaceRoot !== workspaceRoot) {
    throw new CliArgumentError({
      message: `SQLite binding workspace mismatch for ${storePath}; refusing to open it from ${workspaceRoot}`,
    })
  }
  return {
    storePath: decode({ schema: AbsolutePath, value: storePath }),
    rootId: binding.rootId,
    dataSourceId: binding.dataSourceId,
    workspaceRoot,
  }
}

const sqlitePathFromFlags = (flags: Map<string, string | true>): string | undefined => {
  if (flags.has('store') === true) {
    throw new CliArgumentError({
      message:
        '--store has been removed; use --sqlite <path> for explicit self-contained database files',
    })
  }
  return optionalFlag({ flags, name: 'sqlite' })
}

const normalizeOptionalSqlitePath = (value: string | undefined): string | undefined =>
  value === undefined ? undefined : normalizeAbsolutePath(value)

/**
 * Parses `argv` into a `CliContext`, opening the sync store in the process.
 *
 * Discovers a self-contained SQLite file for workspace commands. Advanced commands may pass
 * `--sqlite`; legacy `--store` is rejected so callers do not depend on split-store paths.
 * Throws `CliArgumentError` for missing or invalid flags; the caller is responsible
 * for closing `context.store` when the command completes.
 */
export const parseCliContext = ({
  argv,
  resolvedCommand,
}: {
  readonly argv: ReadonlyArray<string>
  readonly resolvedCommand?: CliCommand
}): CliContext => {
  const flags = parseFlags(argv)
  const command = resolvedCommand ?? parseCliCommand(argv)
  const commandDryRun = 'dryRun' in command && command.dryRun === true
  const maxExecutorSteps = positiveIntegerFlag({ flags, name: 'max-executor-steps' })
  const requiredCapabilities = capabilityListFlag({ flags, name: 'required-capabilities' })
  const explicitSqlitePath = normalizeOptionalSqlitePath(sqlitePathFromFlags(flags))
  if (flags.has('query-contract-json') === true) {
    throw new CliArgumentError({
      message:
        '--query-contract-json is not supported by the product CLI; database-ID SQLite files are always full Notion database replicas',
    })
  }
  if (command._tag === 'sync-from-notion' && explicitSqlitePath !== undefined) {
    throw new CliArgumentError({
      message:
        'sync --from-notion always creates <workspace>/<database-id>.sqlite; --sqlite is only for established replica commands',
    })
  }
  const discovered =
    command._tag === 'sync-from-notion'
      ? (() => {
          const databaseId =
            command.remoteRef._tag === 'database'
              ? command.remoteRef.databaseId
              : (command.remoteRef.sourceDatabaseId ?? command.dataSourceId)
          const storePath =
            explicitSqlitePath ??
            defaultSqlitePath({ workspaceRoot: command.workspaceRoot, databaseId })
          const existingBinding =
            commandDryRun === true || existsSync(storePath) === false
              ? undefined
              : readSelfContainedBinding(storePath)
          if (
            existingBinding !== undefined &&
            existingBinding.dataSourceId !== command.dataSourceId
          )
            throw new CliArgumentError({
              message: `SQLite file is already bound to data source ${existingBinding.dataSourceId}; refusing to establish ${command.dataSourceId}`,
            })
          return {
            storePath: commandDryRun === true ? ':memory:' : storePath,
            rootId: rootIdForDataSource(command.dataSourceId),
            dataSourceId: command.dataSourceId,
            workspaceRoot: command.workspaceRoot,
          }
        })()
      : command._tag === 'export' && command.fromNotion !== undefined
        ? (() => {
            const workspaceRoot = command.workspaceRoot
            if (workspaceRoot === undefined && explicitSqlitePath === undefined) {
              throw new CliArgumentError({
                message: 'export --from-notion requires a workspace root or --sqlite <path>',
              })
            }
            const existingBinding =
              explicitSqlitePath === undefined
                ? undefined
                : readSelfContainedBinding(explicitSqlitePath)
            if (
              existingBinding !== undefined &&
              existingBinding.dataSourceId !== command.fromNotion.dataSourceId
            ) {
              throw new CliArgumentError({
                message: `SQLite file is already bound to data source ${existingBinding.dataSourceId}; refusing to export ${command.fromNotion.dataSourceId}`,
              })
            }
            const resolvedWorkspaceRoot = decode({
              schema: AbsolutePath,
              value: workspaceRoot ?? existingBinding?.workspaceRoot,
            })
            const databaseId =
              command.fromNotion.remoteRef._tag === 'database'
                ? command.fromNotion.remoteRef.databaseId
                : (command.fromNotion.remoteRef.sourceDatabaseId ?? command.fromNotion.dataSourceId)
            const storePath =
              explicitSqlitePath ??
              defaultSqlitePath({ workspaceRoot: resolvedWorkspaceRoot, databaseId })
            return {
              storePath,
              rootId: rootIdForDataSource(command.fromNotion.dataSourceId),
              dataSourceId: command.fromNotion.dataSourceId,
              workspaceRoot: resolvedWorkspaceRoot,
            }
          })()
        : (command._tag === 'sync' || command._tag === 'status') &&
            command.workspaceRoot !== undefined
          ? (() => {
              return explicitSqlitePath === undefined
                ? discoverSelfContainedStore(command.workspaceRoot)
                : (() => {
                    const binding = readSelfContainedBinding(explicitSqlitePath)
                    if (binding === undefined) {
                      throw new CliArgumentError({
                        message: `SQLite file ${explicitSqlitePath} is missing datasource-sync internals`,
                      })
                    }
                    return {
                      storePath: decode({ schema: AbsolutePath, value: explicitSqlitePath }),
                      rootId: binding.rootId,
                      dataSourceId: binding.dataSourceId,
                      workspaceRoot: command.workspaceRoot,
                    }
                  })()
            })()
          : command._tag === 'export' && command.workspaceRoot !== undefined
            ? (() => {
                return explicitSqlitePath === undefined
                  ? discoverSelfContainedStore(command.workspaceRoot)
                  : (() => {
                      const binding = readSelfContainedBinding(explicitSqlitePath)
                      if (binding === undefined) {
                        throw new CliArgumentError({
                          message: `SQLite file ${explicitSqlitePath} is missing datasource-sync internals`,
                        })
                      }
                      return {
                        storePath: decode({ schema: AbsolutePath, value: explicitSqlitePath }),
                        rootId: binding.rootId,
                        dataSourceId: binding.dataSourceId,
                        workspaceRoot: command.workspaceRoot,
                      }
                    })()
              })()
            : explicitSqlitePath !== undefined && flags.has('root-id') === false
              ? (() => {
                  const binding = readSelfContainedBinding(explicitSqlitePath)
                  if (binding === undefined) {
                    throw new CliArgumentError({
                      message: `SQLite file ${explicitSqlitePath} is missing datasource-sync internals`,
                    })
                  }
                  return {
                    storePath: explicitSqlitePath,
                    rootId: binding.rootId,
                    dataSourceId: binding.dataSourceId,
                    workspaceRoot: decode({ schema: AbsolutePath, value: binding.workspaceRoot }),
                  }
                })()
              : (() => {
                  const storePath = explicitSqlitePath ?? requiredFlag({ flags, name: 'sqlite' })
                  return {
                    storePath,
                    rootId: decode({
                      schema: SyncRootId,
                      value: requiredFlag({ flags, name: 'root-id' }),
                    }),
                    dataSourceId: decode({
                      schema: DataSourceId,
                      value: requiredFlag({ flags, name: 'data-source-id' }),
                    }),
                    workspaceRoot: decode({
                      schema: AbsolutePath,
                      value: requiredFlag({ flags, name: 'workspace-root' }),
                    }),
                  }
                })()
  const rowLimit = command._tag === 'sync-from-notion' ? command.limit : undefined
  const baseQueryContract = fullReplicaQueryContract()
  const queryContract =
    rowLimit === undefined
      ? baseQueryContract
      : decode({
          schema: QueryContract,
          value: {
            ...baseQueryContract,
            pageSize: Math.min(baseQueryContract.pageSize, rowLimit),
          },
        })
  const schemaProperties =
    optionalFlag({ flags, name: 'schema-properties-json' }) === undefined
      ? undefined
      : (decodeJson({
          schema: Schema.Array(SchemaPropertyObservationJson),
          value: requiredFlag({ flags, name: 'schema-properties-json' }),
        }) as ReadonlyArray<SchemaPropertyObservation>)
  if (discovered.storePath !== ':memory:') {
    mkdirSync(dirname(discovered.storePath), { recursive: true })
    if (command._tag !== 'sync-from-notion' && existsSync(discovered.storePath) === true) {
      validateSelfContainedSqlite(discovered.storePath)
    }
  }
  const store = openNotionSyncStore({ path: discovered.storePath })
  if (
    command._tag !== 'sync-from-notion' &&
    (command._tag !== 'export' || command.fromNotion === undefined) &&
    discovered.storePath !== ':memory:'
  ) {
    const binding = store.readWorkspaceBinding(discovered.rootId)
    if (binding === undefined) {
      store.close()
      throw new CliArgumentError({
        message: `SQLite file ${discovered.storePath} is missing _nds_workspace_binding; refusing to open`,
      })
    }
    if (
      binding.dataSourceId !== discovered.dataSourceId ||
      binding.workspaceRoot !== discovered.workspaceRoot
    ) {
      store.close()
      throw new CliArgumentError({
        message: `SQLite binding mismatch for ${discovered.storePath}; refusing to open`,
      })
    }
  }

  return {
    store,
    storePath: discovered.storePath,
    rootId: discovered.rootId,
    dataSourceId: discovered.dataSourceId,
    workspaceRoot: discovered.workspaceRoot,
    queryContract,
    ...(schemaProperties === undefined ? {} : { schemaProperties }),
    ...(requiredCapabilities === undefined ? {} : { requiredCapabilities }),
    ...(flags.has('no-materialize-bodies') === false && commandDryRun !== true
      ? {}
      : { materializeBodies: false }),
    ...(rowLimit === undefined ? {} : { rowLimit }),
    ...(maxExecutorSteps === undefined ? {} : { maxExecutorSteps }),
  }
}

const cliGatewayConfigurationError = (operation: GatewayOperation) =>
  makeGatewayError({
    operation,
    guard: 'CapabilityPreflightFailed',
    message:
      'Missing Notion API token for the live CLI gateway; set NOTION_API_TOKEN or NOTION_TOKEN, or use the library runner with an injected gateway client.',
  })

const tokenFromEnv = (env: CliRuntimeEnv): string | undefined => {
  if (env.NOTION_API_TOKEN !== undefined && env.NOTION_API_TOKEN.length > 0) {
    return env.NOTION_API_TOKEN
  }
  if (env.NOTION_TOKEN !== undefined && env.NOTION_TOKEN.length > 0) {
    return env.NOTION_TOKEN
  }
  return undefined
}

const liveNotionClientFromEnv = (env: CliRuntimeEnv): NotionGatewayClient | undefined => {
  const envToken = tokenFromEnv(env)
  if (envToken === undefined) return undefined

  const liveBaseLayer = Layer.mergeAll(
    NotionConfigLive({
      authToken: Redacted.make(envToken),
      retryEnabled: true,
      maxRetries: 2,
      retryBaseDelay: 500,
    }),
    FetchHttpClient.layer,
  )

  return makeNotionEffectClientGatewayClient((effect) => effect.pipe(Effect.provide(liveBaseLayer)))
}

const resolveDatabaseDataSourceId = ({
  databaseId,
  client,
}: {
  readonly databaseId: string
  readonly client: NotionGatewayClient
}): Effect.Effect<
  { readonly dataSourceId: typeof DataSourceId.Type; readonly databaseId: string },
  CliArgumentError
> =>
  client.retrieveDatabase({ databaseId }).pipe(
    Effect.mapError(
      () =>
        new CliArgumentError({
          message:
            'Unable to retrieve the Notion database while resolving --from-notion; verify the integration can access the database, or pass a data source ID directly.',
        }),
    ),
    Effect.flatMap((database) => {
      const dataSources = database.data_sources ?? []
      if (dataSources.length === 1) {
        const [dataSource] = dataSources
        return Effect.succeed({
          dataSourceId: decode({ schema: DataSourceId, value: dataSource?.id }),
          databaseId: String(database.id),
        })
      }
      return Effect.fail(
        new CliArgumentError({
          message:
            dataSources.length === 0
              ? 'The Notion database does not report any child data sources; verify the integration can access the database, or pass a data source ID directly.'
              : 'The Notion database has multiple child data sources; pass the desired data source ID directly.',
        }),
      )
    }),
  )

/** Resolve any `database`-tagged Notion remote refs on a CLI command into concrete `data-source` refs by querying the gateway — passes other commands through unchanged. */
export const resolveCliCommandNotionRefs = ({
  command,
  options = {},
}: {
  readonly command: CliCommand
  readonly options?: CliRuntimeOptions
}): Effect.Effect<CliCommand, CliArgumentError> => {
  const databaseRef =
    command._tag === 'sync-from-notion' && command.remoteRef._tag === 'database'
      ? command.remoteRef
      : command._tag === 'export' &&
          command.fromNotion !== undefined &&
          command.fromNotion.remoteRef._tag === 'database'
        ? command.fromNotion.remoteRef
        : undefined

  if (databaseRef === undefined) {
    return Effect.succeed(command)
  }
  const client = options.gatewayClient ?? liveNotionClientFromEnv(options.env ?? process.env)
  if (client === undefined) {
    return Effect.fail(
      new CliArgumentError({
        message: `${command._tag === 'export' ? 'export' : 'sync'} --from-notion received a Notion database URL, but no Notion client is configured to resolve its child data source; set NOTION_API_TOKEN/NOTION_TOKEN or pass a data source ID directly.`,
      }),
    )
  }
  const databaseId = databaseRef.databaseId
  return resolveDatabaseDataSourceId({
    databaseId,
    client,
  }).pipe(
    Effect.map((resolved) =>
      command._tag === 'sync-from-notion'
        ? {
            ...command,
            dataSourceId: resolved.dataSourceId,
            remoteRef: {
              _tag: 'data-source' as const,
              dataSourceId: resolved.dataSourceId,
              sourceDatabaseId: resolved.databaseId,
            },
          }
        : {
            ...command,
            fromNotion: {
              dataSourceId: resolved.dataSourceId,
              remoteRef: {
                _tag: 'data-source' as const,
                dataSourceId: resolved.dataSourceId,
                sourceDatabaseId: resolved.databaseId,
              },
            },
          },
    ),
  )
}

const missingTokenCliGateway: NotionDataSourceGatewayShape = {
  apiContract: makeNotionApiContract({ supportedCapabilities: [] }),
  preflightCapabilities: () => Effect.fail(cliGatewayConfigurationError('preflightCapabilities')),
  retrieveDataSource: () => Effect.fail(cliGatewayConfigurationError('retrieveDataSource')),
  queryRows: () => Stream.fail(cliGatewayConfigurationError('queryRows')),
  retrievePage: () => Effect.fail(cliGatewayConfigurationError('retrievePage')),
  retrievePageProperty: () => Stream.fail(cliGatewayConfigurationError('retrievePageProperty')),
  patchPageProperties: () => Effect.fail(cliGatewayConfigurationError('patchPageProperties')),
  createPage: () => Effect.fail(cliGatewayConfigurationError('createPage')),
  patchDataSourceSchema: () => Effect.fail(cliGatewayConfigurationError('patchDataSourceSchema')),
  patchDataSourceMetadata: () =>
    Effect.fail(cliGatewayConfigurationError('patchDataSourceMetadata')),
  patchDatabaseMetadata: () => Effect.fail(cliGatewayConfigurationError('patchDatabaseMetadata')),
  trashPage: () => Effect.fail(cliGatewayConfigurationError('trashPage')),
  restorePage: () => Effect.fail(cliGatewayConfigurationError('restorePage')),
}

/**
 * Builds the Effect `Layer` that provides `NotionDataSourceGateway`, `PageBodySyncPort`,
 * and `LocalWorkspacePort` for a CLI command run.
 *
 * Gateway priority: explicit `options.gateway` > `options.gatewayClient` > live Notion client
 * (token from env) > stub that returns `CapabilityPreflightFailed` on every call.
 * Body sync and workspace materialization default to the live NotionMD adapters when the CLI
 * owns the live Notion runtime. Injected gateway/body/workspace ports keep their explicit
 * test or library semantics.
 */
export const makeCliRuntimeLayer = ({
  context,
  options = {},
}: {
  readonly context: CliContext
  readonly options?: CliRuntimeOptions
}): Layer.Layer<NotionDataSourceGateway | PageBodySyncPort | LocalWorkspacePort> => {
  const envToken = tokenFromEnv(options.env ?? process.env)
  const liveBaseLayer =
    envToken === undefined
      ? undefined
      : Layer.mergeAll(
          NotionConfigLive({
            authToken: Redacted.make(envToken),
            retryEnabled: true,
            maxRetries: 2,
            retryBaseDelay: 500,
          }),
          FetchHttpClient.layer,
        )
  const useLiveNotionMdBodyRuntime =
    liveBaseLayer !== undefined &&
    options.gateway === undefined &&
    options.gatewayClient === undefined &&
    options.body === undefined
  const notionMdLiveLayer =
    liveBaseLayer === undefined
      ? undefined
      : Layer.mergeAll(
          NotionMdGatewayLive.pipe(Layer.provide(liveBaseLayer)),
          NmdStateStoreLive.pipe(Layer.provide(NodeContext.layer)),
        )
  const gatewayLayer =
    options.gateway !== undefined
      ? Layer.succeed(NotionDataSourceGateway, options.gateway)
      : options.gatewayClient !== undefined
        ? Layer.succeed(
            NotionDataSourceGateway,
            makeNotionDataSourceGatewayFromClient({ client: options.gatewayClient }),
          )
        : liveBaseLayer === undefined
          ? Layer.succeed(NotionDataSourceGateway, missingTokenCliGateway)
          : NotionDataSourceGatewayLive.pipe(Layer.provide(liveBaseLayer))

  const bodyLayer =
    options.body !== undefined
      ? Layer.succeed(PageBodySyncPort, options.body)
      : useLiveNotionMdBodyRuntime === false || notionMdLiveLayer === undefined
        ? Layer.succeed(
            PageBodySyncPort,
            makeUnsupportedPageBodySyncPort({
              message:
                'No NotionMD PageBodySyncPort is configured for the CLI; body sync is fail-closed until the NotionMD adapter is injected.',
            }),
          )
        : Layer.effect(
            PageBodySyncPort,
            Effect.gen(function* () {
              const gateway = yield* NotionMdGateway
              const stateStore = yield* NmdStateStore
              return makeNotionMdPageBodySyncPort({
                root: context.workspaceRoot,
                gateway,
                stateStore,
              })
            }),
          ).pipe(Layer.provide(notionMdLiveLayer))

  const workspaceLayer =
    options.workspace !== undefined
      ? Layer.succeed(LocalWorkspacePort, options.workspace)
      : useLiveNotionMdBodyRuntime === true && notionMdLiveLayer !== undefined
        ? Layer.effect(
            LocalWorkspacePort,
            Effect.gen(function* () {
              const gateway = yield* NotionMdGateway
              const stateStore = yield* NmdStateStore
              return makeNotionMdMaterializingLocalWorkspacePort({
                root: context.workspaceRoot,
                gateway,
                stateStore,
              })
            }),
          ).pipe(Layer.provide(notionMdLiveLayer))
        : filesystemLocalWorkspacePortLayer({ root: context.workspaceRoot })

  return Layer.mergeAll(gatewayLayer, bodyLayer, workspaceLayer)
}

/** Convenience wrapper that runs `runCliCommand` with the runtime layer built by `makeCliRuntimeLayer`. */
export const runCliCommandWithRuntime = ({
  command,
  context,
  options = {},
}: {
  readonly command: CliCommand
  readonly context: CliContext
  readonly options?: CliRuntimeOptions
}) =>
  runCliCommand(command, context).pipe(Effect.provide(makeCliRuntimeLayer({ context, options })))

const syncProgressCommandTags = new Set<CliCommand['_tag']>([
  'init',
  'pull',
  'push',
  'sync',
  'sync-from-notion',
  'export',
])

const shouldShowSyncProgress = (command: CliCommand): boolean =>
  syncProgressCommandTags.has(command._tag)

const rateLimitProgressEventFromHttp = (event: NotionHttpTelemetryEvent): SyncProgressEvent => {
  const rateLimit = Option.getOrUndefined(event.rateLimit)
  return {
    _tag: 'rate-limit',
    operation: event.operation,
    method: event.method,
    status: event.status,
    requestCount: event._tag === 'response' ? event.quotaCost : 0,
    ...(rateLimit === undefined ? {} : { remaining: rateLimit.remaining }),
    ...(rateLimit === undefined || rateLimit.resetAfterSeconds <= 0
      ? {}
      : { resetAfterSeconds: rateLimit.resetAfterSeconds }),
    ...(event._tag === 'retry' ? { retryDelayMs: event.delayMs } : {}),
  }
}

const renderPlainRateLimitProgress = (event: SyncProgressEvent): string | undefined => {
  if (event._tag !== 'rate-limit') {
    return undefined
  }
  const details = [
    `${event.method} ${event.operation}`,
    `status ${event.status.toString()}`,
    event.remaining === undefined ? undefined : `${event.remaining.toString()} quota remaining`,
    event.resetAfterSeconds === undefined ? undefined : `reset ${event.resetAfterSeconds}s`,
    event.retryDelayMs === undefined ? undefined : `retry ${Math.ceil(event.retryDelayMs / 1000)}s`,
  ].filter((item): item is string => item !== undefined)
  return details.join(' · ')
}

const runWithPlainSyncProgress = <A, E, R>({
  command,
  effect,
}: {
  readonly command: CliCommand
  readonly effect: Effect.Effect<A, E, R>
}): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.provideService(SyncProgress, {
      report: (event) =>
        Effect.sync(() => {
          const rateLimit = renderPlainRateLimitProgress(event)
          if (rateLimit !== undefined) {
            process.stderr.write(`notion db ${command._tag} rate ${rateLimit}\n`)
            return
          }
          const suffix =
            event._tag === 'query-page'
              ? ` ${event.rows.toString()} rows`
              : event._tag === 'hydrate-row'
                ? ` ${event.current.toString()}/${event.total.toString()} rows`
                : event._tag === 'executor-step'
                  ? ` ${event.current.toString()}/${event.max.toString()} write steps`
                  : ''
          const phase = event._tag === 'phase' ? event.phase : event._tag
          process.stderr.write(`notion db ${command._tag} ${phase}${suffix}\n`)
        }),
    }),
    Effect.provideService(NotionHttpTelemetry, {
      report: (event) =>
        Effect.sync(() => {
          const progressEvent = rateLimitProgressEventFromHttp(event)
          const rateLimit = renderPlainRateLimitProgress(progressEvent)
          if (rateLimit !== undefined) {
            process.stderr.write(`notion db ${command._tag} rate ${rateLimit}\n`)
          }
        }),
    }),
    Effect.tap(() =>
      Effect.sync(() => {
        process.stderr.write(`notion db ${command._tag} complete 100%\n`)
      }),
    ),
  )

const runWithCliSyncProgress = <A, E, R>({
  command,
  effect,
}: {
  readonly command: CliCommand
  readonly effect: Effect.Effect<A, E, R>
}): Effect.Effect<A, E, R> => {
  const loadTuiProgress = Effect.promise(() => import('./progress.ts')).pipe(
    Effect.flatMap((progressModule) =>
      Effect.promise(() => import('@overeng/tui-react')).pipe(
        Effect.flatMap((tuiReact) =>
          Effect.promise(() => import('@overeng/tui-react/node')).pipe(
            Effect.map((tuiReactNode) => ({ progressModule, tuiReact, tuiReactNode })),
          ),
        ),
      ),
    ),
    Effect.either,
  )

  return loadTuiProgress.pipe(
    Effect.flatMap((loaded) => {
      if (Either.isLeft(loaded) === true) {
        return runWithPlainSyncProgress({ command, effect })
      }
      const { progressModule, tuiReact, tuiReactNode } = loaded.right
      const progressApp = progressModule.createSyncProgressApp(command._tag)
      const progressView = progressModule.createSyncProgressView(progressApp)

      return Effect.scoped(
        progressApp.run(progressView).pipe(
          Effect.flatMap((tui) =>
            effect.pipe(
              Effect.provideService(SyncProgress, {
                report: (event) =>
                  Effect.sync(() => {
                    tui.dispatch({ _tag: 'ApplyEvent', event })
                  }),
              }),
              Effect.provideService(NotionHttpTelemetry, {
                report: (event) =>
                  Effect.sync(() => {
                    tui.dispatch({
                      _tag: 'ApplyEvent',
                      event: rateLimitProgressEventFromHttp(event),
                    })
                  }),
              }),
              Effect.tap(() =>
                Effect.sync(() => {
                  tui.dispatch({
                    _tag: 'ApplyEvent',
                    event: { _tag: 'phase', phase: 'complete' },
                  })
                }),
              ),
            ),
          ),
          Effect.provide(
            Layer.mergeAll(
              tuiReactNode.outputModeLayer('ci-plain'),
              Layer.succeed(tuiReact.ViewOutputStreamTag, process.stderr),
            ),
          ),
        ),
      )
    }),
  )
}

/**
 * Top-level CLI entry point: parses `argv`, rejects unsupported commands early, runs the command,
 * and writes the JSON result to `stdout`. The store is closed via `Effect.ensuring` regardless of outcome.
 *
 * When the module is executed directly (`import.meta.main`), it wires OTel and calls
 * `NodeRuntime.runMain`, writing errors as JSON to `stderr`.
 */
export const runCliMain = ({
  argv,
  options = {},
}: {
  readonly argv: ReadonlyArray<string>
  readonly options?: CliRuntimeOptions
}) =>
  Effect.gen(function* () {
    const completionShell = completionShellFromArgv(argv)
    if (completionShell !== undefined) {
      const completions = yield* renderDatasourceSyncCompletions({
        programName: 'notion db',
        shell: completionShell,
      })
      yield* Effect.sync(() => process.stdout.write(completions))
      return
    }

    if (isVersionArgv(argv) === true) {
      yield* Effect.sync(() => process.stdout.write(`${cliVersion}\n`))
      return
    }

    if (isHelpArgv(argv) === true) {
      yield* Effect.sync(() => process.stdout.write(renderCliHelpText()))
      return
    }

    const command = yield* Effect.try({
      try: () => parseCliCommand(argv),
      catch: (cause) => cause,
    })
    if (isUnsupportedCommand(command) === true) {
      return yield* Effect.fail(makeUnsupportedCommandError(command._tag))
    }

    const resolvedCommand = yield* resolveCliCommandNotionRefs({ command, options })
    const context = yield* Effect.try({
      try: () => parseCliContext({ argv, resolvedCommand }),
      catch: (cause) => cause,
    })
    const commandEffect = runCliCommandWithRuntime({ command: resolvedCommand, context, options })
    const effectWithProgress =
      shouldShowSyncProgress(resolvedCommand) === true
        ? runWithCliSyncProgress({ command: resolvedCommand, effect: commandEffect })
        : commandEffect

    yield* effectWithProgress.pipe(
      Effect.tap((result) => Effect.sync(() => process.stdout.write(renderCliResultJson(result)))),
      Effect.ensuring(Effect.sync(() => context.store.close())),
    )
  })

const serviceNameForArgv = (argv: ReadonlyArray<string>): string => {
  try {
    return serviceNameForCliCommand(parseCliCommand(argv))
  } catch {
    return otelServiceNameForCliArgv(argv)
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  runCliMain({ argv }).pipe(
    Effect.tapError((error) => Effect.sync(() => process.stderr.write(renderCliErrorJson(error)))),
    Effect.scoped,
    Effect.provide(makeOtelCliLayer({ serviceName: serviceNameForArgv(argv) })),
    NodeRuntime.runMain({ disableErrorReporting: true }),
  )
}
