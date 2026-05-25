import { Effect, Layer, Schema, Stream } from 'effect'

import { queryContractHash as computeQueryContractHash } from './canonical.ts'
import type {
  PagePropertyItemPage,
  RetrievePagePropertyInput,
  PatchDataSourceSchemaCommand,
  PatchPagePropertiesCommand,
  QueryRowsPage,
  RestorePageCommand,
  TrashPageCommand,
} from './commands.ts'
import {
  PageSnapshot,
  QueryCursor,
  RowPageSnapshot,
  type CapabilityName,
  type DataSourceId,
  type DataSourceSnapshot,
  type NotionApiContract,
  type PageId,
  type PagePropertyItem,
  type PageSnapshot as PageSnapshotType,
  type PropertyId,
  type RowPageSnapshot as RowPageSnapshotType,
} from './domain.ts'
import type { NotionGatewayError } from './errors.ts'
import {
  makeCapabilityPreflightResult,
  makeGatewayError,
  makeNotionApiContract,
  makeNotionDataSourceGateway,
  notionRequestId,
} from './gateway.ts'
import { shortSpanId, spanAttr, spanAttributes, spanLabel, spanNames } from './observability.ts'
import { NotionDataSourceGateway, type NotionDataSourceGatewayShape } from './ports.ts'
import { hashStoreBytes } from './store-projections.ts'

export type FakePagePropertyItems = {
  readonly propertyId: PropertyId
  readonly items: ReadonlyArray<PagePropertyItem>
}

export type FakeNotionPageRecord = {
  readonly snapshot: PageSnapshotType
  readonly row: RowPageSnapshotType
  readonly propertyItems?: ReadonlyArray<FakePagePropertyItems>
  readonly visibleInFilteredQueries?: boolean
}

export type FakeNotionDataSourceGatewayConfig = {
  readonly configuredApiVersion?: string
  readonly apiContract?: NotionApiContract
  readonly clientVersion?: string
  readonly supportedCapabilities?: ReadonlyArray<CapabilityName>
  readonly dataSources: ReadonlyArray<DataSourceSnapshot>
  readonly pages: ReadonlyArray<FakeNotionPageRecord>
  readonly queryResultCap?: number
  readonly queryPageLimit?: number
  readonly pagePropertyPageSize?: number
  readonly permissionAmbiguousDataSourceIds?: ReadonlyArray<DataSourceId>
  readonly permissionAmbiguousPageIds?: ReadonlyArray<PageId>
  readonly readAfterWriteMismatchPageIds?: ReadonlyArray<PageId>
}

type MutablePageRecord = {
  snapshot: PageSnapshotType
  row: RowPageSnapshotType
  readonly propertyItems: ReadonlyArray<FakePagePropertyItems>
  readonly visibleInFilteredQueries: boolean
}

const pageKey = (pageId: PageId): string => pageId
const dataSourceKey = (dataSourceId: DataSourceId): string => dataSourceId
const propertyKey = (propertyId: PropertyId): string => propertyId

const cursorForOffset = (offset: number): QueryCursor => QueryCursor.make(`offset:${offset}`)

const parseCursor = (
  cursor: QueryCursor | null,
  operation: 'queryRows' | 'retrievePageProperty',
): Effect.Effect<number, NotionGatewayError> => {
  if (cursor === null) {
    return Effect.succeed(0)
  }

  const match = /^offset:(\d+)$/.exec(cursor)

  return match?.[1] === undefined
    ? Effect.fail(
        makeGatewayError({
          operation,
          message: `Unsupported fake gateway cursor: ${cursor}`,
        }),
      )
    : Effect.succeed(Number.parseInt(match[1], 10))
}

const readRequestId = (sequence: number) => notionRequestId(`fake-req-${sequence}`)

const fakeGatewaySpan = (input: {
  readonly operation: string
  readonly apiVersion: string
  readonly dataSourceId?: DataSourceId
  readonly pageId?: PageId
}) => {
  const entityId = input.pageId ?? input.dataSourceId

  return {
    attributes: spanAttributes({
      [spanAttr.spanLabel]: spanLabel(
        input.operation,
        entityId === undefined ? undefined : shortSpanId(entityId),
      ),
      [spanAttr.processRole]: 'fake-gateway',
      [spanAttr.operation]: input.operation,
      [spanAttr.apiVersion]: input.apiVersion,
      [spanAttr.dataSourceId]: input.dataSourceId,
      [spanAttr.pageId]: input.pageId,
    }),
  }
}

const hasPageId = (pageIds: ReadonlySet<string>, pageId: PageId): boolean =>
  pageIds.has(pageKey(pageId))
const hasDataSourceId = (dataSourceIds: ReadonlySet<string>, dataSourceId: DataSourceId): boolean =>
  dataSourceIds.has(dataSourceKey(dataSourceId))
const encodeDateTimeUtc = Schema.encodeSync(Schema.DateTimeUtc)

const findDataSource = (
  dataSources: Map<string, DataSourceSnapshot>,
  dataSourceId: DataSourceId,
  operation: 'retrieveDataSource' | 'queryRows' | 'patchDataSourceSchema',
): Effect.Effect<DataSourceSnapshot, NotionGatewayError> => {
  const snapshot = dataSources.get(dataSourceKey(dataSourceId))

  return snapshot === undefined
    ? Effect.fail(
        makeGatewayError({
          operation,
          dataSourceId,
          guard: 'PermissionAmbiguous',
          message: `Data source is unavailable or not shared: ${dataSourceId}`,
        }),
      )
    : Effect.succeed(snapshot)
}

const findPage = (
  pages: Map<string, MutablePageRecord>,
  pageId: PageId,
  operation:
    | 'retrievePage'
    | 'retrievePageProperty'
    | 'patchPageProperties'
    | 'trashPage'
    | 'restorePage',
): Effect.Effect<MutablePageRecord, NotionGatewayError> => {
  const page = pages.get(pageKey(pageId))

  return page === undefined
    ? Effect.fail(
        makeGatewayError({
          operation,
          pageId,
          guard: 'PermissionAmbiguous',
          message: `Page is unavailable or not shared: ${pageId}`,
        }),
      )
    : Effect.succeed(page)
}

const validatePageSize = ({
  operation,
  pageSize,
  dataSourceId,
  pageId,
}: {
  readonly operation: 'queryRows' | 'retrievePageProperty'
  readonly pageSize: number
  readonly dataSourceId?: DataSourceId
  readonly pageId?: PageId
}): Effect.Effect<number, NotionGatewayError> =>
  Number.isInteger(pageSize) && pageSize >= 1 && pageSize <= 100
    ? Effect.succeed(pageSize)
    : Effect.fail(
        makeGatewayError({
          operation,
          ...(dataSourceId === undefined ? {} : { dataSourceId }),
          ...(pageId === undefined ? {} : { pageId }),
          guard: 'UnsupportedRemoteShape',
          message: `Invalid Notion pagination page size: ${pageSize}`,
        }),
      )

export { queryContractHash } from './canonical.ts'

export const makeFakeNotionDataSourceGateway = (
  config: FakeNotionDataSourceGatewayConfig,
): NotionDataSourceGatewayShape => {
  const apiContract =
    config.apiContract ??
    makeNotionApiContract({
      ...(config.clientVersion === undefined ? {} : { clientVersion: config.clientVersion }),
      ...(config.supportedCapabilities === undefined
        ? {}
        : { supportedCapabilities: config.supportedCapabilities }),
    })
  const dataSources = new Map(
    config.dataSources.map((snapshot) => [dataSourceKey(snapshot.dataSourceId), snapshot]),
  )
  const pages = new Map(
    config.pages.map((record) => [
      pageKey(record.snapshot.pageId),
      {
        snapshot: record.snapshot,
        row: record.row,
        propertyItems: record.propertyItems ?? [],
        visibleInFilteredQueries: record.visibleInFilteredQueries ?? true,
      },
    ]),
  )
  const permissionAmbiguousPageIds = new Set(
    (config.permissionAmbiguousPageIds ?? []).map((pageId) => pageKey(pageId)),
  )
  const permissionAmbiguousDataSourceIds = new Set(
    (config.permissionAmbiguousDataSourceIds ?? []).map((sourceId) => dataSourceKey(sourceId)),
  )
  const readAfterWriteMismatchPageIds = new Set(
    (config.readAfterWriteMismatchPageIds ?? []).map((pageId) => pageKey(pageId)),
  )
  const queryResultCap = config.queryResultCap ?? Number.POSITIVE_INFINITY
  const queryPageLimit = config.queryPageLimit ?? Number.POSITIVE_INFINITY
  const pagePropertyPageSize = config.pagePropertyPageSize ?? 100
  let requestSequence = 0

  const nextRequestId = () => readRequestId(++requestSequence)

  return makeNotionDataSourceGateway({
    ...(config.configuredApiVersion === undefined
      ? {}
      : { configuredApiVersion: config.configuredApiVersion }),
    apiContract,
    preflightCapabilities: (input) =>
      Effect.succeed(makeCapabilityPreflightResult({ input, apiContract })).pipe(
        Effect.withSpan(
          spanNames.fakeGatewayRequest,
          fakeGatewaySpan({
            operation: 'preflightCapabilities',
            apiVersion: apiContract.apiVersion,
            dataSourceId: input.dataSourceId,
          }),
        ),
      ),
    retrieveDataSource: (id) =>
      hasDataSourceId(permissionAmbiguousDataSourceIds, id)
        ? Effect.fail(
            makeGatewayError({
              operation: 'retrieveDataSource',
              dataSourceId: id,
              guard: 'PermissionAmbiguous',
              message: `Data source retrieval is permission ambiguous: ${id}`,
            }),
          )
        : findDataSource(dataSources, id, 'retrieveDataSource').pipe(
            Effect.withSpan(
              spanNames.fakeGatewayRequest,
              fakeGatewaySpan({
                operation: 'retrieveDataSource',
                apiVersion: apiContract.apiVersion,
                dataSourceId: id,
              }),
            ),
          ),
    queryRows: (input) =>
      Stream.fromEffect(
        (hasDataSourceId(permissionAmbiguousDataSourceIds, input.dataSourceId)
          ? Effect.fail(
              makeGatewayError({
                operation: 'queryRows',
                dataSourceId: input.dataSourceId,
                guard: 'PermissionAmbiguous',
                message: `Data source query is permission ambiguous: ${input.dataSourceId}`,
              }),
            )
          : findDataSource(dataSources, input.dataSourceId, 'queryRows')
        ).pipe(
          Effect.zipRight(
            validatePageSize({
              operation: 'queryRows',
              pageSize: input.queryContract.pageSize,
              dataSourceId: input.dataSourceId,
            }),
          ),
          Effect.zipWith(parseCursor(input.startCursor, 'queryRows'), (pageSize, startOffset) => ({
            pageSize,
            startOffset,
          })),
          Effect.map(({ pageSize, startOffset }): ReadonlyArray<QueryRowsPage> => {
            const highWatermark =
              input.queryContract.highWatermark === null
                ? undefined
                : encodeDateTimeUtc(input.queryContract.highWatermark)
            const allRows = [...pages.values()]
              .filter((page) => page.snapshot.dataSourceId === input.dataSourceId)
              .filter(
                (page) =>
                  input.queryContract.membershipScope === 'all-data-source-rows' ||
                  page.visibleInFilteredQueries === true,
              )
              .filter(
                (page) =>
                  highWatermark === undefined ||
                  encodeDateTimeUtc(page.row.lastEditedTime) >= highWatermark,
              )
              .toSorted((left, right) => {
                const edited = encodeDateTimeUtc(left.row.lastEditedTime).localeCompare(
                  encodeDateTimeUtc(right.row.lastEditedTime),
                )
                return edited === 0
                  ? pageKey(left.row.pageId).localeCompare(pageKey(right.row.pageId))
                  : edited
              })
              .map((page) => ({
                _tag: 'QueriedRow' as const,
                pageId: page.row.pageId,
                propertiesHash: page.row.propertiesHash,
                lastEditedTime: page.row.lastEditedTime,
                inTrash: page.row.inTrash,
              }))
            const cap = Math.max(0, Math.min(queryResultCap, allRows.length))
            const cappedAtLimit = allRows.length > cap
            const visibleRows = allRows.slice(0, cap)
            const result: QueryRowsPage[] = []

            for (
              let offset = startOffset;
              offset < visibleRows.length || result.length === 0;
              offset += pageSize
            ) {
              const rows = visibleRows.slice(offset, offset + pageSize)
              const nextOffset = offset + rows.length
              const hasMore = nextOffset < visibleRows.length
              result.push({
                _tag: 'QueryRowsPage',
                apiVersion: apiContract.apiVersion,
                requestId: nextRequestId(),
                queryContractHash: computeQueryContractHash(input, apiContract.apiVersion),
                rows,
                nextCursor: hasMore ? cursorForOffset(nextOffset) : null,
                hasMore,
                cappedAtLimit: cappedAtLimit && hasMore === false,
              })

              if (hasMore === false) {
                break
              }
            }

            return result.slice(0, queryPageLimit)
          }),
        ),
      ).pipe(Stream.flatMap((queryPages) => Stream.fromIterable(queryPages))),
    retrievePage: (id) =>
      hasPageId(permissionAmbiguousPageIds, id)
        ? Effect.fail(
            makeGatewayError({
              operation: 'retrievePage',
              pageId: id,
              guard: 'PermissionAmbiguous',
              message: `Page retrieval is permission ambiguous: ${id}`,
            }),
          )
        : findPage(pages, id, 'retrievePage').pipe(
            Effect.map((page) => page.snapshot),
            Effect.withSpan(
              spanNames.fakeGatewayRequest,
              fakeGatewaySpan({
                operation: 'retrievePage',
                apiVersion: apiContract.apiVersion,
                pageId: id,
              }),
            ),
          ),
    retrievePageProperty: (input: RetrievePagePropertyInput) =>
      Stream.fromEffect(
        (hasPageId(permissionAmbiguousPageIds, input.pageId)
          ? Effect.fail(
              makeGatewayError({
                operation: 'retrievePageProperty',
                pageId: input.pageId,
                guard: 'PermissionAmbiguous',
                message: `Page property retrieval is permission ambiguous: ${input.pageId}`,
              }),
            )
          : findPage(pages, input.pageId, 'retrievePageProperty')
        ).pipe(
          Effect.zipWith(
            validatePageSize({
              operation: 'retrievePageProperty',
              pageSize: pagePropertyPageSize,
              pageId: input.pageId,
            }),
            (page, pageSize) => ({ page, pageSize }),
          ),
          Effect.flatMap((page) =>
            parseCursor(input.startCursor, 'retrievePageProperty').pipe(
              Effect.flatMap(
                (
                  startOffset,
                ): Effect.Effect<ReadonlyArray<PagePropertyItemPage>, NotionGatewayError> => {
                  const propertyItems = page.page.propertyItems.find(
                    (property) =>
                      propertyKey(property.propertyId) === propertyKey(input.propertyId),
                  )

                  if (propertyItems === undefined) {
                    return Effect.fail(
                      makeGatewayError({
                        operation: 'retrievePageProperty',
                        pageId: page.page.snapshot.pageId,
                        guard: 'CurrentSurfaceMissing',
                        message: `Page property is unavailable or not shared: ${input.propertyId}`,
                      }),
                    )
                  }

                  const items = propertyItems.items
                  const result: PagePropertyItemPage[] = []

                  for (
                    let offset = startOffset;
                    offset < items.length || result.length === 0;
                    offset += page.pageSize
                  ) {
                    const pageItems = items.slice(offset, offset + page.pageSize)
                    const nextOffset = offset + pageItems.length
                    const hasMore = nextOffset < items.length
                    result.push({
                      _tag: 'PagePropertyItemPage',
                      apiVersion: apiContract.apiVersion,
                      requestId: nextRequestId(),
                      pageId: input.pageId,
                      propertyId: input.propertyId,
                      items: pageItems,
                      nextCursor: hasMore ? cursorForOffset(nextOffset) : null,
                      hasMore,
                    })

                    if (hasMore === false) {
                      break
                    }
                  }

                  return Effect.succeed(result)
                },
              ),
            ),
          ),
        ),
      ).pipe(Stream.flatMap((propertyPages) => Stream.fromIterable(propertyPages))),
    patchPageProperties: (command: PatchPagePropertiesCommand) =>
      findPage(pages, command.pageId, 'patchPageProperties').pipe(
        Effect.flatMap((page) => {
          if (page.snapshot.propertiesHash !== command.basePropertiesHash) {
            return Effect.fail(
              makeGatewayError({
                operation: 'patchPageProperties',
                pageId: command.pageId,
                guard: 'StaleSurfaceBase',
                message: `Patch base does not match current page properties: ${command.pageId}`,
              }),
            )
          }

          const requestId = nextRequestId()

          if (hasPageId(readAfterWriteMismatchPageIds, command.pageId) === false) {
            const propertiesHash = hashStoreBytes(
              `page-properties\t${command.pageId}\t${command.commandId}\t${Object.keys(
                command.propertyPatch,
              )
                .toSorted()
                .join(',')}`,
            )
            page.snapshot = PageSnapshot.make({ ...page.snapshot, propertiesHash, requestId })
            page.row = RowPageSnapshot.make({ ...page.row, propertiesHash })
          }

          return Effect.succeed(requestId)
        }),
      ),
    patchDataSourceSchema: (command: PatchDataSourceSchemaCommand) =>
      findDataSource(dataSources, command.dataSourceId, 'patchDataSourceSchema').pipe(
        Effect.flatMap((snapshot) => {
          if (snapshot.schemaHash !== command.baseSchemaHash) {
            return Effect.fail(
              makeGatewayError({
                operation: 'patchDataSourceSchema',
                dataSourceId: command.dataSourceId,
                guard: 'StaleSurfaceBase',
                message: `Schema patch base does not match current data source schema: ${command.dataSourceId}`,
              }),
            )
          }

          const requestId = nextRequestId()
          dataSources.set(dataSourceKey(command.dataSourceId), {
            ...snapshot,
            requestId,
            schemaHash: hashStoreBytes(
              `data-source-schema\t${command.dataSourceId}\t${command.commandId}\t${Object.keys(
                command.schemaPatch,
              )
                .toSorted()
                .join(',')}`,
            ),
          })

          return Effect.succeed(requestId)
        }),
      ),
    trashPage: (command: TrashPageCommand) =>
      findPage(pages, command.pageId, 'trashPage').pipe(
        Effect.flatMap((page) => {
          if (page.snapshot.propertiesHash !== command.basePropertiesHash) {
            return Effect.fail(
              makeGatewayError({
                operation: 'trashPage',
                pageId: command.pageId,
                guard: 'StaleSurfaceBase',
                message: `Trash base does not match current page properties: ${command.pageId}`,
              }),
            )
          }

          const requestId = nextRequestId()
          page.snapshot = PageSnapshot.make({ ...page.snapshot, requestId, inTrash: true })
          page.row = RowPageSnapshot.make({ ...page.row, inTrash: true })
          return Effect.succeed(requestId)
        }),
      ),
    restorePage: (command: RestorePageCommand) =>
      findPage(pages, command.pageId, 'restorePage').pipe(
        Effect.flatMap((page) => {
          if (page.snapshot.propertiesHash !== command.basePropertiesHash) {
            return Effect.fail(
              makeGatewayError({
                operation: 'restorePage',
                pageId: command.pageId,
                guard: 'StaleSurfaceBase',
                message: `Restore base does not match current page properties: ${command.pageId}`,
              }),
            )
          }

          const requestId = nextRequestId()
          page.snapshot = PageSnapshot.make({ ...page.snapshot, requestId, inTrash: false })
          page.row = RowPageSnapshot.make({ ...page.row, inTrash: false })
          return Effect.succeed(requestId)
        }),
      ),
  })
}

export const makeFakeNotionDataSourceGatewayLayer = (
  config: FakeNotionDataSourceGatewayConfig,
): Layer.Layer<NotionDataSourceGateway> =>
  Layer.succeed(NotionDataSourceGateway, makeFakeNotionDataSourceGateway(config))
