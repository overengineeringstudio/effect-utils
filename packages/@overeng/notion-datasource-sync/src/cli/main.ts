#!/usr/bin/env node

import { fileURLToPath } from 'node:url'

import { FetchHttpClient } from '@effect/platform'
import { NodeRuntime } from '@effect/platform-node'
import { Effect, Layer, Redacted, Schema, Stream } from 'effect'

import { NotionConfigLive } from '@overeng/notion-effect-client'
import { makeOtelCliLayer } from '@overeng/utils/node/otel'

import { makeUnsupportedPageBodySyncPort } from '../body/adapter.ts'
import { CanonicalPropertyValue, QueryContract } from '../core/commands.ts'
import {
  AbsolutePath,
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
  type CompactionDecision,
  openNotionSyncStore,
  type NotionSyncStore,
} from '../store/store.ts'
import { type SchemaPropertyObservation } from '../sync/observation.ts'
import {
  initOneShotSync,
  pullOneShotSync,
  pushOneShotSync,
  syncOneShot,
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
  | { readonly _tag: 'sync'; readonly dryRun?: boolean }
  | { readonly _tag: 'status' }
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
  readonly rootId: SyncRootIdType
  readonly dataSourceId: typeof DataSourceId.Type
  readonly workspaceRoot: typeof AbsolutePath.Type
  readonly queryContract: QueryContract
  readonly schemaProperties: ReadonlyArray<SchemaPropertyObservation>
  readonly requiredCapabilities?: ReadonlyArray<CapabilityName>
  readonly materializeBodies?: boolean
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
      return pullOneShotSync({ ...context, ...remoteObservationContext(context) }).pipe(
        Effect.map((result) => envelope({ command: command._tag, context, result })),
      )
    case 'push':
      return pushOneShotSync({
        ...context,
        ...withOptionalRuntimeOptions(context),
        ...withOptionalCommandOptions({ command, context }),
      }).pipe(Effect.map((result) => envelope({ command: command._tag, context, result })))
    case 'sync':
      return syncOneShot({
        ...context,
        ...remoteObservationContext(context),
        ...withOptionalRuntimeOptions(context),
        ...withOptionalCommandOptions({ command, context }),
      }).pipe(Effect.map((result) => envelope({ command: command._tag, context, result })))
    case 'status':
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

/** Serializes a `CliResultEnvelope` to a pretty-printed JSON string with a trailing newline for stdout. */
export const renderCliResultJson = (result: CliResultEnvelope): string =>
  `${JSON.stringify(result, null, 2)}\n`

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
  return `${JSON.stringify(errorEnvelope, null, 2)}\n`
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
      const value = decodeJson({ schema: CanonicalPropertyValue, value: requiredFlag({ flags, name: 'value-json' }) })
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
  const words = argv.filter((item) => item.startsWith('--') === false)
  const [command, subcommand] = words
  switch (command) {
    case 'init':
      return {
        _tag: 'init',
        dataSourceId: decode({ schema: DataSourceId, value: requiredFlag({ flags, name: 'data-source-id' }) }),
        workspaceRoot: decode({ schema: AbsolutePath, value: requiredFlag({ flags, name: 'workspace-root' }) }),
        dryRun: flags.has('dry-run'),
      }
    case 'pull':
      return { _tag: 'pull' }
    case 'push':
      return { _tag: 'push', dryRun: flags.has('dry-run') }
    case 'sync':
      return { _tag: 'sync', dryRun: flags.has('dry-run') }
    case 'status':
      return { _tag: 'status' }
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
          conflictId: decode({ schema: SyncEventId, value: requiredFlag({ flags, name: 'conflict-id' }) }),
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

/**
 * Parses `argv` into a `CliContext`, opening the sync store in the process.
 *
 * Requires `--store`, `--root-id`, `--data-source-id`, and `--workspace-root`.
 * Throws `CliArgumentError` for missing or invalid flags; the caller is responsible
 * for closing `context.store` when the command completes.
 */
export const parseCliContext = (argv: ReadonlyArray<string>): CliContext => {
  const flags = parseFlags(argv)
  const storePath = requiredFlag({ flags, name: 'store' })
  const rootId = decode({ schema: SyncRootId, value: requiredFlag({ flags, name: 'root-id' }) })
  const dataSourceId = decode({ schema: DataSourceId, value: requiredFlag({ flags, name: 'data-source-id' }) })
  const workspaceRoot = decode({ schema: AbsolutePath, value: requiredFlag({ flags, name: 'workspace-root' }) })
  const maxExecutorSteps = positiveIntegerFlag({ flags, name: 'max-executor-steps' })
  const requiredCapabilities = capabilityListFlag({ flags, name: 'required-capabilities' })
  const queryContract =
    optionalFlag({ flags, name: 'query-contract-json' }) === undefined
      ? decode({ schema: QueryContract, value: {
          _tag: 'QueryContract',
          apiVersion: '2026-03-11',
          filter: null,
          sorts: [],
          pageSize: 100,
          highWatermark: null,
          membershipScope: 'all-data-source-rows',
        }})
      : decodeJson({ schema: QueryContract, value: requiredFlag({ flags, name: 'query-contract-json' }) })
  const schemaProperties =
    optionalFlag({ flags, name: 'schema-properties-json' }) === undefined
      ? []
      : (decodeJson({
          schema: Schema.Array(SchemaPropertyObservationJson),
          value: requiredFlag({ flags, name: 'schema-properties-json' }),
        }) as ReadonlyArray<SchemaPropertyObservation>)
  const store = openNotionSyncStore({ path: storePath })

  return {
    store,
    rootId,
    dataSourceId,
    workspaceRoot,
    queryContract,
    schemaProperties,
    ...(requiredCapabilities === undefined ? {} : { requiredCapabilities }),
    ...(flags.has('no-materialize-bodies') === false ? {} : { materializeBodies: false }),
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

const missingTokenCliGateway: NotionDataSourceGatewayShape = {
  apiContract: makeNotionApiContract({ supportedCapabilities: [] }),
  preflightCapabilities: () => Effect.fail(cliGatewayConfigurationError('preflightCapabilities')),
  retrieveDataSource: () => Effect.fail(cliGatewayConfigurationError('retrieveDataSource')),
  queryRows: () => Stream.fail(cliGatewayConfigurationError('queryRows')),
  retrievePage: () => Effect.fail(cliGatewayConfigurationError('retrievePage')),
  retrievePageProperty: () => Stream.fail(cliGatewayConfigurationError('retrievePageProperty')),
  patchPageProperties: () => Effect.fail(cliGatewayConfigurationError('patchPageProperties')),
  patchDataSourceSchema: () => Effect.fail(cliGatewayConfigurationError('patchDataSourceSchema')),
  patchDataSourceMetadata: () =>
    Effect.fail(cliGatewayConfigurationError('patchDataSourceMetadata')),
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
  const gatewayLayer =
    options.gateway !== undefined
      ? Layer.succeed(NotionDataSourceGateway, options.gateway)
      : options.gatewayClient !== undefined
        ? Layer.succeed(
            NotionDataSourceGateway,
            makeNotionDataSourceGatewayFromClient({ client: options.gatewayClient }),
          )
        : envToken === undefined
          ? Layer.succeed(NotionDataSourceGateway, missingTokenCliGateway)
          : NotionDataSourceGatewayLive.pipe(
              Layer.provide(
                Layer.mergeAll(
                  NotionConfigLive({
                    authToken: Redacted.make(envToken),
                    retryEnabled: true,
                    maxRetries: 2,
                    retryBaseDelay: 500,
                  }),
                  FetchHttpClient.layer,
                ),
              ),
            )

  return Layer.mergeAll(
    gatewayLayer,
    Layer.succeed(
      PageBodySyncPort,
      options.body ??
        makeUnsupportedPageBodySyncPort({
          message:
            'No NotionMD PageBodySyncPort is configured for the CLI; body sync is fail-closed until the NotionMD adapter is injected.',
        }),
    ),
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
}) => runCliCommand(command, context).pipe(Effect.provide(makeCliRuntimeLayer({ context, options })))

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

    const context = yield* Effect.try({
      try: () => parseCliContext(argv),
      catch: (cause) => cause,
    })
    yield* runCliCommandWithRuntime({ command, context, options }).pipe(
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
