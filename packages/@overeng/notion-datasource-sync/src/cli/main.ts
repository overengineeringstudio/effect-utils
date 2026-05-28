#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import { FetchHttpClient } from '@effect/platform'
import { NodeRuntime } from '@effect/platform-node'
import { Effect, Layer, Redacted, Schema, Stream } from 'effect'

import { NotionConfigLive, parseNotionUuid } from '@overeng/notion-effect-client'
import { NotionMdGateway, NotionMdGatewayLive } from '@overeng/notion-md'
import { makeOtelCliLayer } from '@overeng/utils/node/otel'

import { makeUnsupportedPageBodySyncPort } from '../body/adapter.ts'
import { makeNotionMdPageBodySyncPort } from '../body/notion-md.ts'
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
import { readUserActionSurface, type UserActionSurface } from '../core/result-envelope.ts'
import { readOneShotSyncStatus, type OneShotSyncStatus } from '../core/status.ts'
import { runWatchDaemon, type WatchDaemonRunResult } from '../daemon/watch.ts'
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
    }
  | {
      readonly _tag: 'sync-from-notion'
      readonly dataSourceId: typeof DataSourceId.Type
      readonly remoteRef: NotionRemoteRef
      readonly workspaceRoot: typeof AbsolutePath.Type
      readonly dryRun?: boolean
      readonly limit?: number
    }
  | { readonly _tag: 'status'; readonly workspaceRoot?: typeof AbsolutePath.Type }
  | {
      readonly _tag: 'watch'
      readonly statePath: string
      readonly maxCycles?: number
    }
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

const rootIdForDataSource = (dataSourceId: typeof DataSourceId.Type): SyncRootIdType =>
  decode({ schema: SyncRootId, value: `data-source:${dataSourceId}` })

const fullReplicaQueryContract = (): QueryContract =>
  decode({
    schema: QueryContract,
    value: {
      _tag: 'QueryContract',
      apiVersion: '2026-03-11',
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

const parseNotionRemoteRef = (value: string): NotionRemoteRef => {
  const id = parseNotionDataSourceRef(value)
  if (/^https?:\/\//iu.test(value) === true) {
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

/** Returns the OTel service name for the given parsed command — `watch` maps to the daemon service, all others to the CLI service. */
export const serviceNameForCliCommand = (command: CliCommand): string =>
  command._tag === 'watch' ? otelServiceNames.daemon : otelServiceNames.cli

const SchemaPropertyObservationJson = Schema.Struct({
  propertyId: PropertyId,
  name: Schema.optional(Schema.NonEmptyTrimmedString),
  type: Schema.optional(Schema.NonEmptyTrimmedString),
  configHash: Hash,
  writeClass: Schema.Literal('writable', 'computed', 'unsupported'),
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
  | UserCommandResultEnvelope
  | DoctorResult
>

type CliCommandRuntimeError =
  | LocalStoreError
  | NotionGatewayError
  | BodySyncError
  | LocalStorageError
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
      return pushOneShotSync({
        ...context,
        ...withOptionalRuntimeOptions(context),
        ...withOptionalCommandOptions({ command, context }),
      }).pipe(Effect.map((result) => envelope({ command: command._tag, context, result })))
    case 'sync':
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
          result: readOneShotSyncStatus({ store: context.store, rootId: context.rootId }),
        }),
      )
    case 'watch':
      return runWatchDaemon({
        ...context,
        ...remoteObservationContext(context),
        ...withOptionalObservationLimit(context),
        statePath: command.statePath,
        ...(command.maxCycles === undefined ? {} : { maxCycles: command.maxCycles }),
        ...withOptionalRuntimeOptions(context),
      }).pipe(Effect.map((result) => envelope({ command: command._tag, context, result })))
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
          [spanAttr.processRole]: processRoleForCliCommand(command._tag),
          [spanAttr.rootId]: context.rootId,
          [spanAttr.dataSourceId]: context.dataSourceId,
          [spanAttr.dryRun]: 'dryRun' in command ? command.dryRun === true : undefined,
          [spanAttr.maxCycles]: command._tag === 'watch' ? command.maxCycles : undefined,
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
    if (next !== undefined && next.startsWith('--') === false) {
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
      if (next !== undefined && next.startsWith('--') === false) index += 1
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

const optionalLimitFlag = (flags: Map<string, string | true>): number | undefined => {
  const limit = positiveIntegerFlag({ flags, name: 'limit' })
  const maxRows = positiveIntegerFlag({ flags, name: 'max-rows' })
  if (limit !== undefined && maxRows !== undefined) {
    throw new CliArgumentError({ message: 'Use only one of --limit or --max-rows' })
  }
  return limit ?? maxRows
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
      return {
        _tag: 'sync',
        ...(words[1] === undefined ? {} : { workspaceRoot: normalizeAbsolutePath(words[1]) }),
        dryRun: flags.has('dry-run'),
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
    case 'watch': {
      const maxCycles = positiveIntegerFlag({ flags, name: 'max-cycles' })
      return {
        _tag: 'watch',
        statePath: requiredFlag({ flags, name: 'state' }),
        ...(maxCycles === undefined ? {} : { maxCycles }),
      }
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
      'Expected one of: init, pull, push, sync, status, watch, conflicts list, conflicts resolve, forget, restore, migrate store, migrate schema, repair, doctor',
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
  if (command._tag !== 'sync-from-notion' && discovered.storePath !== ':memory:') {
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
          message: `Unable to retrieve Notion database ${databaseId} while resolving --from-notion; pass a data source ID directly if this is not a database URL.`,
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
              ? `Notion database ${databaseId} does not report any child data sources; pass a data source ID directly.`
              : `Notion database ${databaseId} has multiple child data sources; pass the desired data source ID explicitly.`,
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
  if (command._tag !== 'sync-from-notion' || command.remoteRef._tag !== 'database') {
    return Effect.succeed(command)
  }
  const client = options.gatewayClient ?? liveNotionClientFromEnv(options.env ?? process.env)
  if (client === undefined) {
    return Effect.fail(
      new CliArgumentError({
        message:
          'sync --from-notion received a Notion database URL, but no Notion client is configured to resolve its child data source; set NOTION_API_TOKEN/NOTION_TOKEN or pass a data source ID directly.',
      }),
    )
  }
  const databaseId = command.remoteRef.databaseId
  return resolveDatabaseDataSourceId({
    databaseId,
    client,
  }).pipe(
    Effect.map((resolved) => ({
      ...command,
      dataSourceId: resolved.dataSourceId,
      remoteRef: {
        _tag: 'data-source' as const,
        dataSourceId: resolved.dataSourceId,
        sourceDatabaseId: resolved.databaseId,
      },
    })),
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
 * Body sync defaults to an unsupported stub; workspace defaults to the filesystem adapter.
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
      : liveBaseLayer === undefined ||
          options.gateway !== undefined ||
          options.gatewayClient !== undefined
        ? Layer.succeed(
            PageBodySyncPort,
            makeUnsupportedPageBodySyncPort({
              message:
                'No NotionMD PageBodySyncPort is configured for the CLI; body sync is fail-closed until the NotionMD adapter is injected.',
            }),
          )
        : Layer.effect(
            PageBodySyncPort,
            NotionMdGateway.pipe(
              Effect.map((gateway) => makeNotionMdPageBodySyncPort({ gateway })),
            ),
          ).pipe(Layer.provide(NotionMdGatewayLive.pipe(Layer.provide(liveBaseLayer))))

  return Layer.mergeAll(
    gatewayLayer,
    bodyLayer,
    options.workspace === undefined
      ? filesystemLocalWorkspacePortLayer({ root: context.workspaceRoot })
      : Layer.succeed(LocalWorkspacePort, options.workspace),
  )
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

/**
 * Top-level CLI entry point: parses `argv`, rejects unsupported commands early, runs the command,
 * and writes the JSON result to `stdout`. The store is closed via `Effect.ensuring` regardless of outcome.
 *
 * When the module is executed directly (`process.argv[1]` matches), it wires OTel and calls
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
    yield* runCliCommandWithRuntime({ command: resolvedCommand, context, options }).pipe(
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  runCliMain({ argv }).pipe(
    Effect.tapError((error) => Effect.sync(() => process.stderr.write(renderCliErrorJson(error)))),
    Effect.scoped,
    Effect.provide(makeOtelCliLayer({ serviceName: serviceNameForArgv(argv) })),
    NodeRuntime.runMain({ disableErrorReporting: true }),
  )
}
