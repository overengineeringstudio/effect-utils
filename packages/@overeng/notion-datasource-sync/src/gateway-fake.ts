import { Effect, Layer, Stream } from 'effect'

import type {
  PagePropertyItemPage,
  RetrievePagePropertyInput,
  PatchDataSourceSchemaCommand,
  PatchPagePropertiesCommand,
  QueryRowsInput,
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
  type Hash,
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
  readonly pagePropertyPageSize?: number
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

const hasPageId = (pageIds: ReadonlySet<string>, pageId: PageId): boolean =>
  pageIds.has(pageKey(pageId))

const findDataSource = (
  dataSources: Map<string, DataSourceSnapshot>,
  dataSourceId: DataSourceId,
): Effect.Effect<DataSourceSnapshot, NotionGatewayError> => {
  const snapshot = dataSources.get(dataSourceKey(dataSourceId))

  return snapshot === undefined
    ? Effect.fail(
        makeGatewayError({
          operation: 'retrieveDataSource',
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

const queryContractHash = (input: QueryRowsInput): Hash =>
  hashStoreBytes(
    [
      'query',
      input.dataSourceId,
      input.queryContract.apiVersion,
      input.queryContract.membershipScope,
      input.queryContract.pageSize.toString(),
      input.queryContract.filter?._tag ?? 'no-filter',
      input.queryContract.sorts.map((sort) => `${sort.propertyId}:${sort.direction}`).join(','),
    ].join('\t'),
  )

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
  const readAfterWriteMismatchPageIds = new Set(
    (config.readAfterWriteMismatchPageIds ?? []).map((pageId) => pageKey(pageId)),
  )
  const queryResultCap = config.queryResultCap ?? Number.POSITIVE_INFINITY
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
        Effect.withSpan('NotionDatasourceSync.FakeGateway.preflightCapabilities'),
      ),
    retrieveDataSource: (id) =>
      findDataSource(dataSources, id).pipe(
        Effect.withSpan('NotionDatasourceSync.FakeGateway.retrieveDataSource'),
      ),
    queryRows: (input) =>
      Stream.fromEffect(
        parseCursor(input.startCursor, 'queryRows').pipe(
          Effect.map((startOffset): ReadonlyArray<QueryRowsPage> => {
            const pageSize = input.queryContract.pageSize
            const allRows = [...pages.values()]
              .filter((page) => page.snapshot.dataSourceId === input.dataSourceId)
              .filter(
                (page) =>
                  input.queryContract.membershipScope === 'all-data-source-rows' ||
                  page.visibleInFilteredQueries === true,
              )
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
                queryContractHash: queryContractHash(input),
                rows,
                nextCursor: hasMore ? cursorForOffset(nextOffset) : null,
                hasMore,
                cappedAtLimit: cappedAtLimit && hasMore === false,
              })

              if (hasMore === false) {
                break
              }
            }

            return result
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
            Effect.withSpan('NotionDatasourceSync.FakeGateway.retrievePage'),
          ),
    retrievePageProperty: (input: RetrievePagePropertyInput) =>
      Stream.fromEffect(
        findPage(pages, input.pageId, 'retrievePageProperty').pipe(
          Effect.flatMap((page) =>
            parseCursor(input.startCursor, 'retrievePageProperty').pipe(
              Effect.map((startOffset): ReadonlyArray<PagePropertyItemPage> => {
                const items =
                  page.propertyItems.find(
                    (property) =>
                      propertyKey(property.propertyId) === propertyKey(input.propertyId),
                  )?.items ?? []
                const result: PagePropertyItemPage[] = []

                for (
                  let offset = startOffset;
                  offset < items.length || result.length === 0;
                  offset += pagePropertyPageSize
                ) {
                  const pageItems = items.slice(offset, offset + pagePropertyPageSize)
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

                return result
              }),
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
      findDataSource(dataSources, command.dataSourceId).pipe(
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
        Effect.map((page) => {
          const requestId = nextRequestId()
          page.snapshot = PageSnapshot.make({ ...page.snapshot, requestId, inTrash: true })
          page.row = RowPageSnapshot.make({ ...page.row, inTrash: true })
          return requestId
        }),
      ),
    restorePage: (command: RestorePageCommand) =>
      findPage(pages, command.pageId, 'restorePage').pipe(
        Effect.map((page) => {
          const requestId = nextRequestId()
          page.snapshot = PageSnapshot.make({ ...page.snapshot, requestId, inTrash: false })
          page.row = RowPageSnapshot.make({ ...page.row, inTrash: false })
          return requestId
        }),
      ),
  })
}

export const makeFakeNotionDataSourceGatewayLayer = (
  config: FakeNotionDataSourceGatewayConfig,
): Layer.Layer<NotionDataSourceGateway> =>
  Layer.succeed(NotionDataSourceGateway, makeFakeNotionDataSourceGateway(config))
