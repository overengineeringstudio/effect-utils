#!/usr/bin/env bun

import { fileURLToPath } from 'node:url'

import { NodeRuntime } from '@effect/platform-node'
import { Effect, Schema, Stream } from 'effect'

import { makeUnsupportedPageBodySyncPort } from './body-adapter.ts'
import { CanonicalPropertyValue, QueryContract } from './commands.ts'
import { runWatchDaemon, type WatchDaemonRunResult } from './daemon.ts'
import { AbsolutePath, DataSourceId, Hash, PageId, PropertyId } from './domain.ts'
import type {
  BodySyncError,
  LocalStorageError,
  LocalStoreError,
  NotionGatewayError,
} from './errors.ts'
import { SyncEventId, SyncRootId, type SyncRootId as SyncRootIdType } from './events.ts'
import { makeGatewayError, makeNotionApiContract } from './gateway.ts'
import { makeFakeLocalWorkspacePort } from './local-workspace.ts'
import { type SchemaPropertyObservation } from './observation.ts'
import {
  LocalWorkspacePort,
  NotionDataSourceGateway,
  PageBodySyncPort,
  type NotionDataSourceGatewayShape,
} from './ports.ts'
import { readUserActionSurface, type UserActionSurface } from './result-envelope.ts'
import { readOneShotSyncStatus, type OneShotSyncStatus } from './status.ts'
import { type CompactionDecision, openNotionSyncStore, type NotionSyncStore } from './store.ts'
import {
  initOneShotSync,
  pullOneShotSync,
  pushOneShotSync,
  syncOneShot,
  type OneShotPullResult,
  type OneShotPushResult,
  type OneShotSyncResult,
} from './sync.ts'
import {
  forgetPageCommand,
  listUserCommandSurface,
  resolveConflictCommand,
  restorePageCommand,
  type ConflictResolutionChoice,
  type UserCommandResultEnvelope,
} from './user-commands.ts'

export type CliCommand =
  | {
      readonly _tag: 'init'
      readonly dataSourceId: typeof DataSourceId.Type
      readonly workspaceRoot: typeof AbsolutePath.Type
      readonly dryRun?: boolean
    }
  | { readonly _tag: 'pull' }
  | { readonly _tag: 'push' }
  | { readonly _tag: 'sync' }
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
  | { readonly _tag: 'doctor' }

export type CliContext = {
  readonly store: NotionSyncStore
  readonly rootId: SyncRootIdType
  readonly dataSourceId: typeof DataSourceId.Type
  readonly workspaceRoot: typeof AbsolutePath.Type
  readonly queryContract: QueryContract
  readonly schemaProperties: ReadonlyArray<SchemaPropertyObservation>
  readonly maxExecutorSteps?: number
  readonly leaseToken?: string
  readonly leaseDurationMs?: number
  readonly now?: () => Date
}

export type DoctorResult = {
  readonly _tag: 'DoctorResult'
  readonly clean: boolean
  readonly status: OneShotSyncStatus
  readonly compaction: CompactionDecision
  readonly surface: UserActionSurface
}

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

export class CliArgumentError extends Schema.TaggedError<CliArgumentError>()('CliArgumentError', {
  message: Schema.String,
}) {}

const SchemaPropertyObservationJson = Schema.Struct({
  propertyId: PropertyId,
  configHash: Hash,
  writeClass: Schema.Literal('writable', 'computed', 'unsupported'),
}).annotations({ identifier: 'NotionDatasourceSync.Cli.SchemaPropertyObservationJson' })

const decode = <TSchema extends Schema.Schema.AnyNoContext>(
  schema: TSchema,
  value: unknown,
): typeof schema.Type => Schema.decodeUnknownSync(schema)(value)

const decodeJson = <TSchema extends Schema.Schema.AnyNoContext>(
  schema: TSchema,
  value: string,
): typeof schema.Type =>
  Schema.decodeUnknownSync(schema)(
    Schema.decodeUnknownSync(Schema.parseJson(Schema.Unknown))(value),
  )

const withOptionalRuntimeOptions = (context: CliContext) => ({
  ...(context.maxExecutorSteps === undefined ? {} : { maxExecutorSteps: context.maxExecutorSteps }),
  ...(context.leaseToken === undefined ? {} : { leaseToken: context.leaseToken }),
  ...(context.leaseDurationMs === undefined ? {} : { leaseDurationMs: context.leaseDurationMs }),
})

const withOptionalCommandOptions = (
  command: { readonly dryRun?: boolean },
  context: CliContext,
) => ({
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

export const runCliCommand = Effect.fn('NotionDatasourceSync.Cli.runCliCommand')((
  command: CliCommand,
  context: CliContext,
): Effect.Effect<
  CliResultEnvelope<
    | OneShotSyncStatus
    | OneShotPullResult
    | OneShotPushResult
    | OneShotSyncResult
    | WatchDaemonRunResult
    | UserCommandResultEnvelope
    | DoctorResult
  >,
  LocalStoreError | NotionGatewayError | BodySyncError | LocalStorageError,
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
            ...withOptionalCommandOptions(command, context),
          }),
        }),
      )
    case 'pull':
      return pullOneShotSync(context).pipe(
        Effect.map((result) => envelope({ command: command._tag, context, result })),
      )
    case 'push':
      return pushOneShotSync({
        ...context,
        ...withOptionalRuntimeOptions(context),
      }).pipe(Effect.map((result) => envelope({ command: command._tag, context, result })))
    case 'sync':
      return syncOneShot({
        ...context,
        ...withOptionalRuntimeOptions(context),
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
            ...withOptionalCommandOptions(command, context),
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
            ...withOptionalCommandOptions(command, context),
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
            ...withOptionalCommandOptions(command, context),
          }),
        }),
      )
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
})

export const renderCliResultJson = (result: CliResultEnvelope): string =>
  `${JSON.stringify(result, null, 2)}\n`

const parseFlags = (argv: ReadonlyArray<string>): Map<string, string | true> => {
  const flags = new Map<string, string | true>()
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item?.startsWith('--') !== true) continue
    const key = item.slice(2)
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

const requiredFlag = (flags: Map<string, string | true>, name: string): string => {
  const value = flags.get(name)
  if (typeof value === 'string' && value.length > 0) return value
  throw new CliArgumentError({ message: `Missing required --${name}` })
}

const optionalFlag = (flags: Map<string, string | true>, name: string): string | undefined => {
  const value = flags.get(name)
  return typeof value === 'string' ? value : undefined
}

const parseChoice = (flags: Map<string, string | true>): ConflictResolutionChoice => {
  const strategy = optionalFlag(flags, 'strategy') ?? 'keep-remote'
  switch (strategy) {
    case 'keep-remote':
      return { _tag: 'keep-remote' }
    case 'keep-local':
    case 'manual': {
      const value = decodeJson(CanonicalPropertyValue, requiredFlag(flags, 'value-json'))
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

export const parseCliCommand = (argv: ReadonlyArray<string>): CliCommand => {
  const flags = parseFlags(argv)
  const words = argv.filter((item) => item.startsWith('--') === false)
  const [command, subcommand] = words
  switch (command) {
    case 'init':
      return {
        _tag: 'init',
        dataSourceId: decode(DataSourceId, requiredFlag(flags, 'data-source-id')),
        workspaceRoot: decode(AbsolutePath, requiredFlag(flags, 'workspace-root')),
        dryRun: flags.has('dry-run'),
      }
    case 'pull':
      return { _tag: 'pull' }
    case 'push':
      return { _tag: 'push' }
    case 'sync':
      return { _tag: 'sync' }
    case 'status':
      return { _tag: 'status' }
    case 'watch': {
      const maxCycles = optionalFlag(flags, 'max-cycles')
      return {
        _tag: 'watch',
        statePath: requiredFlag(flags, 'state'),
        ...(maxCycles === undefined ? {} : { maxCycles: Number.parseInt(maxCycles, 10) }),
      }
    }
    case 'conflicts':
      if (subcommand === 'list') return { _tag: 'conflicts-list' }
      if (subcommand === 'resolve') {
        return {
          _tag: 'conflicts-resolve',
          conflictId: decode(SyncEventId, requiredFlag(flags, 'conflict-id')),
          choice: parseChoice(flags),
          dryRun: flags.has('dry-run'),
        }
      }
      break
    case 'forget':
      return {
        _tag: 'forget',
        pageId: decode(PageId, requiredFlag(flags, 'page-id')),
        dryRun: flags.has('dry-run'),
      }
    case 'restore':
      return {
        _tag: 'restore',
        pageId: decode(PageId, requiredFlag(flags, 'page-id')),
        dryRun: flags.has('dry-run'),
      }
    case 'doctor':
      return { _tag: 'doctor' }
  }
  throw new CliArgumentError({
    message:
      'Expected one of: init, pull, push, sync, status, watch, conflicts list, conflicts resolve, forget, restore, doctor',
  })
}

export const parseCliContext = (argv: ReadonlyArray<string>): CliContext => {
  const flags = parseFlags(argv)
  const store = openNotionSyncStore({ path: requiredFlag(flags, 'store') })
  const maxExecutorSteps = optionalFlag(flags, 'max-executor-steps')
  return {
    store,
    rootId: decode(SyncRootId, requiredFlag(flags, 'root-id')),
    dataSourceId: decode(DataSourceId, requiredFlag(flags, 'data-source-id')),
    workspaceRoot: decode(AbsolutePath, requiredFlag(flags, 'workspace-root')),
    queryContract:
      optionalFlag(flags, 'query-contract-json') === undefined
        ? decode(QueryContract, {
            _tag: 'QueryContract',
            apiVersion: '2026-03-11',
            filter: null,
            sorts: [],
            pageSize: 100,
            highWatermark: null,
            membershipScope: 'all-data-source-rows',
          })
        : decodeJson(QueryContract, requiredFlag(flags, 'query-contract-json')),
    schemaProperties:
      optionalFlag(flags, 'schema-properties-json') === undefined
        ? []
        : (decodeJson(
            Schema.Array(SchemaPropertyObservationJson),
            requiredFlag(flags, 'schema-properties-json'),
          ) as ReadonlyArray<SchemaPropertyObservation>),
    ...(maxExecutorSteps === undefined
      ? {}
      : { maxExecutorSteps: Number.parseInt(maxExecutorSteps, 10) }),
  }
}

const cliGatewayUnavailable = (operation: string) =>
  makeGatewayError({
    operation: operation as Parameters<typeof makeGatewayError>[0]['operation'],
    guard: 'CapabilityPreflightFailed',
    message:
      'No live Notion gateway is configured for this CLI entrypoint; use the library runner with provided services or add adapter configuration.',
  })

const unsupportedCliGateway: NotionDataSourceGatewayShape = {
  apiContract: makeNotionApiContract({ supportedCapabilities: [] }),
  preflightCapabilities: () => Effect.fail(cliGatewayUnavailable('preflightCapabilities')),
  retrieveDataSource: () => Effect.fail(cliGatewayUnavailable('retrieveDataSource')),
  queryRows: () => Stream.fail(cliGatewayUnavailable('queryRows')),
  retrievePage: () => Effect.fail(cliGatewayUnavailable('retrievePage')),
  retrievePageProperty: () => Stream.fail(cliGatewayUnavailable('retrievePageProperty')),
  patchPageProperties: () => Effect.fail(cliGatewayUnavailable('patchPageProperties')),
  patchDataSourceSchema: () => Effect.fail(cliGatewayUnavailable('patchDataSourceSchema')),
  trashPage: () => Effect.fail(cliGatewayUnavailable('trashPage')),
  restorePage: () => Effect.fail(cliGatewayUnavailable('restorePage')),
}

const runMain = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const command = parseCliCommand(argv)
    const context = parseCliContext(argv)
    const result = yield* runCliCommand(command, context).pipe(
      Effect.provideService(NotionDataSourceGateway, unsupportedCliGateway),
      Effect.provideService(PageBodySyncPort, makeUnsupportedPageBodySyncPort()),
      Effect.provideService(LocalWorkspacePort, makeFakeLocalWorkspacePort()),
    )
    yield* Effect.sync(() => process.stdout.write(renderCliResultJson(result)))
    yield* Effect.sync(() => context.store.close())
  })

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMain(process.argv.slice(2)).pipe(
    Effect.tapError((error) => Effect.sync(() => process.stderr.write(`${String(error)}\n`))),
    NodeRuntime.runMain({ disableErrorReporting: true }),
  )
}
