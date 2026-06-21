import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { HttpClient } from '@effect/platform'
import { Effect, Option, Schema } from 'effect'

import {
  NotionDatabases,
  NotionDataSources,
  type NotionApiError,
  type NotionConfig,
  SchemaHelpers,
} from '@overeng/notion-effect-client'
import type {
  DataSourceSchema,
  SelectOptionConfig,
  StatusPropertySchema,
} from '@overeng/notion-effect-schema'

import {
  isStatusSchemaMutationBlockingDrift,
  planStatusSchema,
  type StatusSchemaPlan,
} from './status-schema-plan.ts'

/** Error thrown when a generated schema module cannot be imported. */
export class StatusSchemaModuleImportError extends Schema.TaggedError<StatusSchemaModuleImportError>()(
  'StatusSchemaModuleImportError',
  {
    path: Schema.String,
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

/** Error thrown when the requested generated schema export is missing. */
export class StatusSchemaExportMissingError extends Schema.TaggedError<StatusSchemaExportMissingError>()(
  'StatusSchemaExportMissingError',
  {
    exportName: Schema.String,
    path: Schema.String,
  },
) {}

/** Error thrown when the desired generated property is not a native status property. */
export class StatusSchemaDesiredPropertyNotStatusError extends Schema.TaggedError<StatusSchemaDesiredPropertyNotStatusError>()(
  'StatusSchemaDesiredPropertyNotStatusError',
  {
    propertyName: Schema.String,
    actualTag: Schema.String,
  },
) {}

/** Error thrown when the live Notion schema is missing the desired status property. */
export class StatusSchemaLivePropertyMissingError extends Schema.TaggedError<StatusSchemaLivePropertyMissingError>()(
  'StatusSchemaLivePropertyMissingError',
  {
    databaseId: Schema.String,
    propertyName: Schema.String,
  },
) {}

/** Error thrown when status drift is present that Notion cannot safely apply. */
export class StatusSchemaUnsupportedDriftError extends Schema.TaggedError<StatusSchemaUnsupportedDriftError>()(
  'StatusSchemaUnsupportedDriftError',
  {
    databaseId: Schema.String,
    propertyName: Schema.String,
    driftCount: Schema.Number,
    message: Schema.String,
  },
) {}

/** Error thrown when read-after-write verification does not prove convergence. */
export class StatusSchemaApplyVerificationError extends Schema.TaggedError<StatusSchemaApplyVerificationError>()(
  'StatusSchemaApplyVerificationError',
  {
    databaseId: Schema.String,
    propertyName: Schema.String,
    missingOptionCount: Schema.Number,
    driftCount: Schema.Number,
    message: Schema.String,
  },
) {}

/** Imported generated schema module. */
export type StatusSchemaModule = Readonly<Record<string, unknown>>

/** Minimal Notion status option update DTO. */
export type StatusOptionUpdate =
  | {
      readonly id: string
      readonly name: string
    }
  | {
      readonly name: string
      readonly color: SelectOptionConfig['color']
    }

/** Gateway used by status schema convergence; tests can provide an in-memory implementation. */
export interface StatusSchemaConvergenceGateway<E = never, R = never> {
  readonly retrieveStatusProperty: (args: {
    readonly databaseId: string
    readonly propertyName: string
  }) => Effect.Effect<
    {
      readonly dataSourceId: string
      readonly live: StatusPropertySchema
    },
    E | StatusSchemaLivePropertyMissingError,
    R
  >
  readonly updateStatusOptions: (args: {
    readonly dataSourceId: string
    readonly propertyName: string
    readonly options: readonly StatusOptionUpdate[]
  }) => Effect.Effect<void, E, R>
}

/** Result of checking native status schema convergence. */
export interface StatusSchemaConvergenceResult {
  readonly dataSourceId: string
  readonly desired: StatusPropertySchema
  readonly live: StatusPropertySchema
  readonly plan: StatusSchemaPlan
}

/** Result of applying native status schema convergence. */
export interface StatusSchemaApplyResult {
  readonly dataSourceId: string
  readonly before: StatusSchemaPlan
  readonly after: StatusSchemaPlan
  readonly updated: boolean
}

const formatUnknownErrorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const getLiveStatusPropertyFromDataSource = (args: {
  readonly databaseId: string
  readonly propertyName: string
  readonly schema: DataSourceSchema
}) => {
  const live = SchemaHelpers.getPropertyByTag({
    schema: args.schema,
    name: args.propertyName,
    tag: 'status',
  })

  if (Option.isNone(live) === true) {
    return new StatusSchemaLivePropertyMissingError({
      databaseId: args.databaseId,
      propertyName: args.propertyName,
    })
  }

  return live.value
}

const statusOptionUpdatePayload = (args: {
  readonly live: StatusPropertySchema
  readonly options: StatusSchemaPlan['applyOptions']
}): readonly StatusOptionUpdate[] => {
  const liveOptionIds = new Set(args.live.status.options.map((option) => option.id))

  return args.options.map((option) => {
    if (liveOptionIds.has(option.id) === true) {
      return {
        id: option.id,
        name: option.name,
      }
    }

    return {
      name: option.name,
      color: option.color,
    }
  })
}

/** Real Notion gateway for native status schema convergence. */
export const makeNotionStatusSchemaGateway = (): StatusSchemaConvergenceGateway<
  NotionApiError,
  NotionConfig | HttpClient.HttpClient
> => ({
  retrieveStatusProperty: (args: { readonly databaseId: string; readonly propertyName: string }) =>
    Effect.gen(function* () {
      const target = yield* NotionDatabases.resolveQueryTarget({ databaseId: args.databaseId })
      const live = getLiveStatusPropertyFromDataSource({
        databaseId: args.databaseId,
        propertyName: args.propertyName,
        schema: target.schemaSource as DataSourceSchema,
      })

      if (live instanceof StatusSchemaLivePropertyMissingError) {
        return yield* live
      }

      return {
        dataSourceId: target.dataSourceId,
        live,
      }
    }),
  updateStatusOptions: (args: {
    readonly dataSourceId: string
    readonly propertyName: string
    readonly options: readonly StatusOptionUpdate[]
  }) =>
    NotionDataSources.update({
      dataSourceId: args.dataSourceId,
      properties: {
        [args.propertyName]: {
          status: {
            options: args.options,
          },
        },
      },
    }).pipe(Effect.asVoid),
})

/** Imports a generated schema module by path. */
export const importStatusSchemaModule = Effect.fnUntraced(function* (path: string) {
  const absolutePath = resolve(path)
  const href = pathToFileURL(absolutePath).href
  return yield* Effect.tryPromise({
    // oxlint-disable-next-line eslint-plugin-import(no-dynamic-require) -- generated schema modules are selected at runtime
    try: () => import(href) as Promise<StatusSchemaModule>,
    catch: (cause) =>
      new StatusSchemaModuleImportError({
        path: absolutePath,
        message: `Failed to import generated schema module: ${formatUnknownErrorMessage(cause)}`,
        cause,
      }),
  })
})

/** Extracts a desired native status property from generated schema metadata. */
export const getDesiredStatusPropertyFromSchemaModule = Effect.fn(function* (args: {
  readonly module: StatusSchemaModule
  readonly path: string
  readonly exportName: string
  readonly propertyName: string
}) {
  const schemaExport = args.module[args.exportName]
  if (schemaExport === undefined) {
    return yield* new StatusSchemaExportMissingError({
      path: args.path,
      exportName: args.exportName,
    })
  }

  const meta = yield* SchemaHelpers.getPropertyMetaFromSchema({
    schema: schemaExport as Schema.Schema.AnyNoContext,
    propertyName: args.propertyName,
  })

  if (meta._tag !== 'status') {
    return yield* new StatusSchemaDesiredPropertyNotStatusError({
      propertyName: args.propertyName,
      actualTag: meta._tag,
    })
  }

  return meta
})

/** Plans native status schema convergence using an injected gateway. */
export const planStatusSchemaConvergence = Effect.fn(function* <E, R>(args: {
  readonly gateway: StatusSchemaConvergenceGateway<E, R>
  readonly databaseId: string
  readonly desired: StatusPropertySchema
}) {
  const live = yield* args.gateway.retrieveStatusProperty({
    databaseId: args.databaseId,
    propertyName: args.desired.name,
  })
  const plan = planStatusSchema({ desired: args.desired, live: live.live })
  return {
    dataSourceId: live.dataSourceId,
    desired: args.desired,
    live: live.live,
    plan,
  } satisfies StatusSchemaConvergenceResult
})

/** Applies additive native status option convergence and verifies by reading Notion again. */
export const applyStatusSchemaConvergence = Effect.fn(function* <E, R>(args: {
  readonly gateway: StatusSchemaConvergenceGateway<E, R>
  readonly databaseId: string
  readonly desired: StatusPropertySchema
}) {
  const before = yield* planStatusSchemaConvergence(args)

  const beforeMutationBlockingDrift = before.plan.unsupportedDrift.filter(
    isStatusSchemaMutationBlockingDrift,
  )
  if (beforeMutationBlockingDrift.length > 0) {
    return yield* new StatusSchemaUnsupportedDriftError({
      databaseId: args.databaseId,
      propertyName: args.desired.name,
      driftCount: beforeMutationBlockingDrift.length,
      message: 'Unsupported native status schema drift blocks safe apply.',
    })
  }

  if (before.plan.missingOptions.length === 0) {
    return {
      dataSourceId: before.dataSourceId,
      before: before.plan,
      after: before.plan,
      updated: false,
    } satisfies StatusSchemaApplyResult
  }

  yield* args.gateway.updateStatusOptions({
    dataSourceId: before.dataSourceId,
    propertyName: args.desired.name,
    options: statusOptionUpdatePayload({
      live: before.live,
      options: before.plan.applyOptions,
    }),
  })

  const after = yield* planStatusSchemaConvergence(args)
  const afterMutationBlockingDrift = after.plan.unsupportedDrift.filter(
    isStatusSchemaMutationBlockingDrift,
  )
  if (after.plan.missingOptions.length > 0 || afterMutationBlockingDrift.length > 0) {
    return yield* new StatusSchemaApplyVerificationError({
      databaseId: args.databaseId,
      propertyName: args.desired.name,
      missingOptionCount: after.plan.missingOptions.length,
      driftCount: afterMutationBlockingDrift.length,
      message: 'Status schema apply did not verify after read-after-write.',
    })
  }

  return {
    dataSourceId: before.dataSourceId,
    before: before.plan,
    after: after.plan,
    updated: true,
  } satisfies StatusSchemaApplyResult
})

/** Loads desired schema metadata and checks native status schema convergence against Notion. */
export const checkStatusSchemaConvergenceFromModule = Effect.fn(function* (args: {
  readonly databaseId: string
  readonly schemaModule: StatusSchemaModule
  readonly schemaModulePath: string
  readonly schemaExport: string
  readonly propertyName: string
}) {
  const desired = yield* getDesiredStatusPropertyFromSchemaModule({
    module: args.schemaModule,
    path: args.schemaModulePath,
    exportName: args.schemaExport,
    propertyName: args.propertyName,
  })

  return yield* planStatusSchemaConvergence({
    gateway: makeNotionStatusSchemaGateway(),
    databaseId: args.databaseId,
    desired,
  })
})

/** Loads desired schema metadata and applies additive native status option convergence against Notion. */
export const applyStatusSchemaConvergenceFromModule = Effect.fn(function* (args: {
  readonly databaseId: string
  readonly schemaModule: StatusSchemaModule
  readonly schemaModulePath: string
  readonly schemaExport: string
  readonly propertyName: string
}) {
  const desired = yield* getDesiredStatusPropertyFromSchemaModule({
    module: args.schemaModule,
    path: args.schemaModulePath,
    exportName: args.schemaExport,
    propertyName: args.propertyName,
  })

  return yield* applyStatusSchemaConvergence({
    gateway: makeNotionStatusSchemaGateway(),
    databaseId: args.databaseId,
    desired,
  })
})
