import { HttpClient } from '@effect/platform'
import { Chunk, Effect, Layer, Option, Schema, Stream } from 'effect'

import {
  NotionConfig,
  NotionDataSources,
  NotionDatabases,
  NotionPages,
  type NotionApiError,
  type PaginatedResult,
} from '@overeng/notion-effect-client'

import type {
  CanonicalDataSourceProperty,
  CanonicalOptionValue,
  CanonicalPropertyValue,
  PatchDataSourceSchemaCommand,
  PatchPagePropertiesCommand,
  QueryRowsInput,
  RestorePageCommand,
  TrashPageCommand,
} from '../core/commands.ts'
import { QueryRowsPage } from '../core/commands.ts'
import {
  DataSourceId,
  DataSourceSnapshot,
  NotionRequestId,
  PageId,
  PageSnapshot,
  QueryCursor,
  RowPageSnapshot,
  type CapabilityName,
  type Hash,
  type NotionApiContract as NotionApiContractType,
} from '../core/domain.ts'
import type { NotionGatewayError } from '../core/errors.ts'
import { blocked, guardStaleSurfaceBase, type GuardName } from '../core/guards.ts'
import { NotionDataSourceGateway, type NotionDataSourceGatewayShape } from '../core/ports.ts'
import { hashStoreBytes } from '../store/projections.ts'
import {
  allGatewayCapabilities,
  makeCapabilityPreflightResult,
  makeGatewayError,
  makeNotionApiContract,
  makeNotionDataSourceGateway,
  supportedNotionApiVersion,
  type GatewayOperation,
} from './gateway.ts'

type NotionDataSourceObject = {
  readonly id: string
  readonly properties: Record<string, unknown>
}

type NotionPageObject = {
  readonly id: string
  readonly parent?: {
    readonly type?: string
    readonly data_source_id?: string
  }
  readonly properties: Record<string, unknown>
  readonly last_edited_time: string
  readonly in_trash: boolean
}

export type NotionGatewayClient = {
  readonly retrieveDataSource: (input: {
    readonly dataSourceId: string
  }) => Effect.Effect<NotionDataSourceObject, unknown>
  readonly queryDataSource: (input: {
    readonly dataSourceId: string
    readonly pageSize: number
    readonly startCursor: string | undefined
    readonly filter: unknown | undefined
    readonly sorts: ReadonlyArray<unknown> | undefined
  }) => Effect.Effect<PaginatedResult<NotionPageObject>, unknown>
  readonly retrievePage: (input: {
    readonly pageId: string
  }) => Effect.Effect<NotionPageObject, unknown>
  readonly updatePage: (input: {
    readonly pageId: string
    readonly properties?: Record<string, unknown>
    readonly inTrash?: boolean
  }) => Effect.Effect<NotionPageObject, unknown>
  readonly updateDataSource: (input: {
    readonly dataSourceId: string
    readonly properties: Record<string, unknown>
  }) => Effect.Effect<NotionDataSourceObject, unknown>
}

export class UnsupportedAdapterOperation extends Schema.TaggedError<UnsupportedAdapterOperation>()(
  'UnsupportedAdapterOperation',
  {
    operation: Schema.String,
    capability: Schema.optional(Schema.String),
    message: Schema.String,
  },
) {}

export type NotionDataSourceGatewayLiveOptions = {
  readonly configuredApiVersion?: string
  readonly clientVersion?: string
}

const supportedNotionEffectClientCapabilities: ReadonlyArray<CapabilityName> = [
  'data_source_retrieve',
  'data_source_query',
  'page_retrieve',
  'page_property_update',
  'page_trash',
  'page_restore',
] as const satisfies ReadonlyArray<CapabilityName>

const unavailableRequestId = NotionRequestId.make('notion-client-success-request-id-unavailable')

const decodeDateTimeUtc = Schema.decodeUnknownSync(Schema.DateTimeUtc)

const observedNow = () => decodeDateTimeUtc(new Date().toISOString())

const stableStringify = (value: unknown): string => {
  if (value === undefined) {
    return '"[undefined]"'
  }

  if (
    value !== null &&
    typeof value === 'object' &&
    'toJSON' in value &&
    typeof value.toJSON === 'function'
  ) {
    return stableStringify(value.toJSON())
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }

  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`
  }

  return JSON.stringify(value)
}

const canonicalHash = (value: unknown): Hash => hashStoreBytes(stableStringify(value))

const notionApiErrorRequestId = (error: NotionApiError): string | undefined =>
  Option.getOrUndefined(error.requestId)

const isNotionApiError = (cause: unknown): cause is NotionApiError =>
  typeof cause === 'object' && cause !== null && '_tag' in cause && cause._tag === 'NotionApiError'

const isNotionGatewayError = (cause: unknown): cause is NotionGatewayError =>
  typeof cause === 'object' &&
  cause !== null &&
  '_tag' in cause &&
  cause._tag === 'NotionGatewayError'

const isPermissionAmbiguous = (error: NotionApiError): boolean =>
  error.status === 403 ||
  error.status === 404 ||
  error.code === 'restricted_resource' ||
  error.code === 'object_not_found'

const mapClientError =
  (input: {
    readonly operation: GatewayOperation
    readonly dataSourceId?: DataSourceId
    readonly pageId?: PageId
  }) =>
  (cause: unknown): NotionGatewayError => {
    if (isNotionGatewayError(cause) === true) {
      return cause
    }

    if (isNotionApiError(cause) === false) {
      return makeGatewayError({
        ...input,
        message: `Notion adapter operation failed: ${input.operation}`,
        cause,
      })
    }

    const requestId = notionApiErrorRequestId(cause)

    return makeGatewayError({
      ...input,
      ...(requestId === undefined ? {} : { requestId }),
      ...(isPermissionAmbiguous(cause) === true ? { guard: 'PermissionAmbiguous' } : {}),
      message: cause.message,
      cause,
    })
  }

const unsupportedOperation = (input: {
  readonly operation: GatewayOperation
  readonly capability?: CapabilityName
  readonly dataSourceId?: DataSourceId
  readonly pageId?: PageId
  readonly message: string
}): NotionGatewayError =>
  makeGatewayError({
    operation: input.operation,
    ...(input.dataSourceId === undefined ? {} : { dataSourceId: input.dataSourceId }),
    ...(input.pageId === undefined ? {} : { pageId: input.pageId }),
    guard: 'UnsupportedRemoteShape',
    message: input.message,
    cause: new UnsupportedAdapterOperation({
      operation: input.operation,
      ...(input.capability === undefined ? {} : { capability: input.capability }),
      message: input.message,
    }),
  })

const gatewayGuardError = (input: {
  readonly operation: GatewayOperation
  readonly guard: GuardName
  readonly dataSourceId?: DataSourceId
  readonly pageId?: PageId
  readonly message: string
}): NotionGatewayError =>
  makeGatewayError({
    operation: input.operation,
    ...(input.dataSourceId === undefined ? {} : { dataSourceId: input.dataSourceId }),
    ...(input.pageId === undefined ? {} : { pageId: input.pageId }),
    guard: input.guard,
    message: input.message,
  })

const optionalDataSourceIdFromPage = (page: NotionPageObject): DataSourceId | undefined =>
  page.parent?.type === 'data_source_id' && page.parent.data_source_id !== undefined
    ? DataSourceId.make(page.parent.data_source_id)
    : undefined

const dataSourceSnapshotFromRemote = (dataSource: NotionDataSourceObject) =>
  DataSourceSnapshot.make({
    _tag: 'DataSourceSnapshot',
    dataSourceId: DataSourceId.make(dataSource.id),
    requestId: unavailableRequestId,
    observedAt: observedNow(),
    schemaHash: canonicalHash(dataSource.properties),
  })

const pageSnapshotFromRemote = (page: NotionPageObject) =>
  PageSnapshot.make({
    _tag: 'PageSnapshot',
    pageId: PageId.make(page.id),
    ...(optionalDataSourceIdFromPage(page) === undefined
      ? {}
      : { dataSourceId: optionalDataSourceIdFromPage(page) }),
    requestId: unavailableRequestId,
    observedAt: observedNow(),
    propertiesHash: canonicalHash(page.properties),
    inTrash: page.in_trash,
  })

const rowSnapshotFromRemote = (page: NotionPageObject) =>
  RowPageSnapshot.make({
    _tag: 'RowPageSnapshot',
    pageId: PageId.make(page.id),
    propertiesHash: canonicalHash(page.properties),
    lastEditedTime: decodeDateTimeUtc(page.last_edited_time),
    inTrash: page.in_trash,
  })

const queryContractHash = (input: QueryRowsInput, apiVersion: string): Hash =>
  hashStoreBytes(
    stableStringify({
      apiVersion,
      dataSourceId: input.dataSourceId,
      queryContract: {
        apiVersion: input.queryContract.apiVersion,
        filter: input.queryContract.filter,
        highWatermark: input.queryContract.highWatermark,
        membershipScope: input.queryContract.membershipScope,
        pageSize: input.queryContract.pageSize,
        sorts: input.queryContract.sorts,
      },
    }),
  )

const optionValue = (option: CanonicalOptionValue) => ({
  ...(option.id === undefined ? {} : { id: option.id }),
  name: option.name,
  ...(option.color === undefined ? {} : { color: option.color }),
})

const encodeDateTimeUtc = (value: typeof Schema.DateTimeUtc.Type): string =>
  Schema.encodeSync(Schema.DateTimeUtc)(value)

const propertyValueToNotion = (
  value: CanonicalPropertyValue,
): Effect.Effect<unknown, NotionGatewayError> => {
  switch (value._tag) {
    case 'title':
      return Effect.succeed({
        title: [{ type: 'text', text: { content: value.plainText } }],
      })
    case 'rich_text':
      return Effect.succeed({
        rich_text: [{ type: 'text', text: { content: value.plainText } }],
      })
    case 'number':
      return Effect.succeed({ number: value.value })
    case 'checkbox':
      return Effect.succeed({ checkbox: value.checked })
    case 'date':
      return Effect.succeed({
        date: {
          start: encodeDateTimeUtc(value.start),
          ...(value.end === null ? {} : { end: encodeDateTimeUtc(value.end) }),
        },
      })
    case 'select':
      return Effect.succeed({
        select: value.option === null ? null : optionValue(value.option),
      })
    case 'multi_select':
      return Effect.succeed({
        multi_select: value.options.map(optionValue),
      })
    case 'status':
      return Effect.succeed({
        status: value.option === null ? null : optionValue(value.option),
      })
    case 'relation':
      return Effect.succeed({
        relation: value.pageIds.map((pageId) => ({ id: pageId })),
      })
    case 'people':
      return Effect.succeed({
        people: value.userIds.map((id) => ({ id })),
      })
    case 'email':
      return Effect.succeed({ email: value.value })
    case 'url':
      return Effect.succeed({ url: value.value })
    case 'phone_number':
      return Effect.succeed({ phone_number: value.value })
    case 'empty':
    case 'files':
      return Effect.fail(
        unsupportedOperation({
          operation: 'patchPageProperties',
          capability: 'page_property_update',
          message: `Canonical ${value._tag} property writes need additional remote shape information`,
        }),
      )
    case 'computed':
      return Effect.fail(
        gatewayGuardError({
          operation: 'patchPageProperties',
          guard: 'ComputedPropertyWrite',
          message: 'Computed Notion properties cannot be written',
        }),
      )
  }
}

export const pagePropertyPatchToNotion = (
  patch: Readonly<Record<string, CanonicalPropertyValue>>,
): Effect.Effect<Record<string, unknown>, NotionGatewayError> =>
  Effect.forEach(Object.entries(patch), ([propertyId, value]) =>
    propertyValueToNotion(value).pipe(Effect.map((notionValue) => [propertyId, notionValue])),
  ).pipe(Effect.map((entries) => Object.fromEntries(entries)))

const dataSourceSchemaPatchToNotion = (
  _patch: Readonly<Record<string, CanonicalDataSourceProperty>>,
): Effect.Effect<Record<string, unknown>, NotionGatewayError> =>
  Effect.fail(
    unsupportedOperation({
      operation: 'patchDataSourceSchema',
      capability: 'schema_update',
      message:
        'Data source schema updates are not supported by this adapter because the canonical command carries only schema identity metadata, not the full Notion schema update payload',
    }),
  )

const querySortsToNotion = (
  input: QueryRowsInput,
): Effect.Effect<ReadonlyArray<unknown> | undefined, NotionGatewayError> =>
  input.queryContract.sorts.length === 0
    ? Effect.succeed(undefined)
    : Effect.succeed(
        input.queryContract.sorts.map((sort) => ({
          property: sort.propertyId,
          direction: sort.direction,
        })),
      )

const queryFilterToNotion = (
  input: QueryRowsInput,
): Effect.Effect<unknown | undefined, NotionGatewayError> => {
  if (input.queryContract.filter === null) {
    return Effect.succeed(undefined)
  }

  return Effect.fail(
    unsupportedOperation({
      operation: 'queryRows',
      capability: 'data_source_query',
      dataSourceId: input.dataSourceId,
      message:
        'Canonical query filters are not yet mapped to Notion filter payloads by the real adapter',
    }),
  )
}

const guardQueryContractSupported = (
  input: QueryRowsInput,
): Effect.Effect<void, NotionGatewayError> =>
  input.queryContract.highWatermark === null
    ? Effect.void
    : Effect.fail(
        unsupportedOperation({
          operation: 'queryRows',
          capability: 'data_source_query',
          dataSourceId: input.dataSourceId,
          message:
            'High-watermark queries are not yet mapped to Notion last_edited_time filters by the real adapter',
        }),
      )

const validateBasePropertiesHash = (input: {
  readonly operation: GatewayOperation
  readonly page: NotionPageObject
  readonly pageId: PageId
  readonly basePropertiesHash: Hash
}) => {
  const currentHash = canonicalHash(input.page.properties)
  const decision = guardStaleSurfaceBase({
    baseHash: input.basePropertiesHash,
    currentHash,
  })

  return decision._tag === 'allowed'
    ? Effect.void
    : Effect.fail(
        gatewayGuardError({
          operation: input.operation,
          guard: decision.guard,
          pageId: input.pageId,
          message: decision.message,
        }),
      )
}

const paginatedResultNextCursor = (result: PaginatedResult<NotionPageObject>): QueryCursor | null =>
  Option.match(result.nextCursor, {
    onNone: () => null,
    onSome: (cursor) => QueryCursor.make(cursor),
  })

const queryRowsPageFromRemote = (input: {
  readonly queryInput: QueryRowsInput
  readonly apiContract: NotionApiContractType
  readonly result: PaginatedResult<NotionPageObject>
}): typeof QueryRowsPage.Type =>
  QueryRowsPage.make({
    _tag: 'QueryRowsPage',
    apiVersion: input.apiContract.apiVersion,
    requestId: unavailableRequestId,
    queryContractHash: queryContractHash(input.queryInput, input.apiContract.apiVersion),
    rows: input.result.results.map((page) => ({
      _tag: 'QueriedRow',
      pageId: rowSnapshotFromRemote(page).pageId,
      propertiesHash: rowSnapshotFromRemote(page).propertiesHash,
      lastEditedTime: rowSnapshotFromRemote(page).lastEditedTime,
      inTrash: rowSnapshotFromRemote(page).inTrash,
    })),
    nextCursor: paginatedResultNextCursor(input.result),
    hasMore: input.result.hasMore,
    cappedAtLimit: false,
  })

export const makeNotionEffectClientGatewayClient = (
  provideClientEnv: <A, E>(
    effect: Effect.Effect<A, E, NotionConfig | HttpClient.HttpClient>,
  ) => Effect.Effect<A, E>,
): NotionGatewayClient => ({
  retrieveDataSource: ({ dataSourceId }) =>
    provideClientEnv(NotionDataSources.retrieve({ dataSourceId })),
  queryDataSource: ({ dataSourceId, pageSize, startCursor, filter, sorts }) =>
    provideClientEnv(
      NotionDatabases.query({
        dataSourceId,
        pageSize,
        ...(startCursor === undefined ? {} : { startCursor }),
        ...(filter === undefined ? {} : { filter: filter as Record<string, unknown> }),
        ...(sorts === undefined ? {} : { sorts: sorts as never }),
      }),
    ),
  retrievePage: ({ pageId }) => provideClientEnv(NotionPages.retrieve({ pageId })),
  updatePage: ({ pageId, properties, inTrash }) =>
    provideClientEnv(
      NotionPages.update({
        pageId,
        ...(properties === undefined ? {} : { properties }),
        ...(inTrash === undefined ? {} : { in_trash: inTrash }),
      }),
    ),
  updateDataSource: ({ dataSourceId, properties }) =>
    provideClientEnv(NotionDataSources.update({ dataSourceId, properties })),
})

export const makeNotionDataSourceGatewayFromClient = (
  client: NotionGatewayClient,
  options: NotionDataSourceGatewayLiveOptions = {},
): NotionDataSourceGatewayShape => {
  const apiContract = makeNotionApiContract({
    clientVersion: options.clientVersion ?? 'notion-effect-client:0.1.0',
    supportedCapabilities: supportedNotionEffectClientCapabilities,
  })

  return makeNotionDataSourceGateway({
    configuredApiVersion: options.configuredApiVersion ?? supportedNotionApiVersion,
    apiContract,
    preflightCapabilities: (input) =>
      client.retrieveDataSource({ dataSourceId: input.dataSourceId }).pipe(
        Effect.map(() => makeCapabilityPreflightResult({ input, apiContract })),
        Effect.mapError(
          mapClientError({
            operation: 'preflightCapabilities',
            dataSourceId: input.dataSourceId,
          }),
        ),
      ),
    retrieveDataSource: (id) =>
      client
        .retrieveDataSource({ dataSourceId: id })
        .pipe(
          Effect.map(dataSourceSnapshotFromRemote),
          Effect.mapError(mapClientError({ operation: 'retrieveDataSource', dataSourceId: id })),
        ),
    queryRows: (input) =>
      Stream.unwrap(
        guardQueryContractSupported(input).pipe(
          Effect.zipRight(queryFilterToNotion(input)),
          Effect.zipWith(querySortsToNotion(input), (filter, sorts) => ({ filter, sorts })),
          Effect.map(({ filter, sorts }) =>
            Stream.unfoldChunkEffect(Option.some(input.startCursor), (cursor) =>
              Option.match(cursor, {
                onNone: () => Effect.succeed(Option.none()),
                onSome: (startCursor) =>
                  client
                    .queryDataSource({
                      dataSourceId: input.dataSourceId,
                      pageSize: input.queryContract.pageSize,
                      startCursor: startCursor ?? undefined,
                      filter,
                      sorts,
                    })
                    .pipe(
                      Effect.map((result) =>
                        Option.some([
                          Chunk.of(
                            queryRowsPageFromRemote({ queryInput: input, apiContract, result }),
                          ),
                          result.hasMore === false || Option.isNone(result.nextCursor) === true
                            ? Option.none<QueryCursor | null>()
                            : Option.some(paginatedResultNextCursor(result)),
                        ] as const),
                      ),
                      Effect.mapError(
                        mapClientError({
                          operation: 'queryRows',
                          dataSourceId: input.dataSourceId,
                        }),
                      ),
                    ),
              }),
            ),
          ),
        ),
      ),
    retrievePage: (id) =>
      client
        .retrievePage({ pageId: id })
        .pipe(
          Effect.map(pageSnapshotFromRemote),
          Effect.mapError(mapClientError({ operation: 'retrievePage', pageId: id })),
        ),
    retrievePageProperty: (input) =>
      Stream.fail(
        unsupportedOperation({
          operation: 'retrievePageProperty',
          capability: 'page_property_paginate',
          pageId: input.pageId,
          message:
            'Page property pagination is not supported because @overeng/notion-effect-client does not expose the page-property-item endpoint yet',
        }),
      ),
    patchPageProperties: (command: PatchPagePropertiesCommand) =>
      client.retrievePage({ pageId: command.pageId }).pipe(
        Effect.mapError(
          mapClientError({ operation: 'patchPageProperties', pageId: command.pageId }),
        ),
        Effect.tap((page) =>
          validateBasePropertiesHash({
            operation: 'patchPageProperties',
            page,
            pageId: command.pageId,
            basePropertiesHash: command.basePropertiesHash,
          }),
        ),
        Effect.zipRight(pagePropertyPatchToNotion(command.propertyPatch)),
        Effect.flatMap((properties) =>
          client.updatePage({ pageId: command.pageId, properties }).pipe(
            Effect.map(() => unavailableRequestId),
            Effect.mapError(
              mapClientError({ operation: 'patchPageProperties', pageId: command.pageId }),
            ),
          ),
        ),
      ),
    patchDataSourceSchema: (command: PatchDataSourceSchemaCommand) =>
      dataSourceSchemaPatchToNotion(command.schemaPatch).pipe(
        Effect.zipRight(
          client.updateDataSource({ dataSourceId: command.dataSourceId, properties: {} }),
        ),
        Effect.as(unavailableRequestId),
        Effect.mapError(
          mapClientError({
            operation: 'patchDataSourceSchema',
            dataSourceId: command.dataSourceId,
          }),
        ),
      ),
    trashPage: (command: TrashPageCommand) =>
      client.retrievePage({ pageId: command.pageId }).pipe(
        Effect.mapError(mapClientError({ operation: 'trashPage', pageId: command.pageId })),
        Effect.tap((page) =>
          validateBasePropertiesHash({
            operation: 'trashPage',
            page,
            pageId: command.pageId,
            basePropertiesHash: command.basePropertiesHash,
          }),
        ),
        Effect.flatMap(() =>
          client
            .updatePage({ pageId: command.pageId, inTrash: true })
            .pipe(
              Effect.as(unavailableRequestId),
              Effect.mapError(mapClientError({ operation: 'trashPage', pageId: command.pageId })),
            ),
        ),
      ),
    restorePage: (command: RestorePageCommand) =>
      client.retrievePage({ pageId: command.pageId }).pipe(
        Effect.mapError(mapClientError({ operation: 'restorePage', pageId: command.pageId })),
        Effect.tap((page) =>
          validateBasePropertiesHash({
            operation: 'restorePage',
            page,
            pageId: command.pageId,
            basePropertiesHash: command.basePropertiesHash,
          }),
        ),
        Effect.flatMap(() =>
          client
            .updatePage({ pageId: command.pageId, inTrash: false })
            .pipe(
              Effect.as(unavailableRequestId),
              Effect.mapError(mapClientError({ operation: 'restorePage', pageId: command.pageId })),
            ),
        ),
      ),
  })
}

export const unsupportedNotionEffectClientGatewayCapabilities = allGatewayCapabilities.filter(
  (capability) => supportedNotionEffectClientCapabilities.includes(capability) === false,
)

export const guardRealAdapterCapabilities = (input: {
  readonly requiredCapabilities: ReadonlyArray<CapabilityName>
}) => {
  const supportedSet = new Set(supportedNotionEffectClientCapabilities)
  const missingCapability = input.requiredCapabilities.find(
    (capability) => supportedSet.has(capability) === false,
  )

  return missingCapability === undefined
    ? { _tag: 'allowed' as const }
    : blocked(
        'CapabilityPreflightFailed',
        `Missing Notion adapter capability: ${missingCapability}`,
      )
}

export const NotionDataSourceGatewayLive: Layer.Layer<
  NotionDataSourceGateway,
  never,
  NotionConfig | HttpClient.HttpClient
> = Layer.effect(
  NotionDataSourceGateway,
  Effect.gen(function* () {
    const config = yield* NotionConfig
    const httpClient = yield* HttpClient.HttpClient
    const provideClientEnv = <A, E>(
      effect: Effect.Effect<A, E, NotionConfig | HttpClient.HttpClient>,
    ) =>
      effect.pipe(
        Effect.provideService(NotionConfig, config),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      )

    return makeNotionDataSourceGatewayFromClient(
      makeNotionEffectClientGatewayClient(provideClientEnv),
    )
  }),
)
