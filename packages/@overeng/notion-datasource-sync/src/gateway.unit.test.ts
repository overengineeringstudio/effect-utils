import { Cause, Chunk, Effect, Schema, Stream } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  DataSourceId,
  DataSourceSnapshot,
  CommandId,
  NotionDataSourceGateway,
  PageId,
  PagePropertyItem,
  PageSnapshot,
  PropertyId,
  QueryContract,
  RowPageSnapshot,
  hashStoreBytes,
  makeFakeNotionDataSourceGatewayLayer,
  makeNotionApiContract,
  type FakeNotionDataSourceGatewayConfig,
  type QueryContract as QueryContractType,
} from './mod.ts'

const decode = <TSchema extends Schema.Schema.AnyNoContext>(schema: TSchema, value: unknown) =>
  Schema.decodeUnknownSync(schema)(value)

const hash = (seed: string) => hashStoreBytes(seed)
const dataSourceId = decode(DataSourceId, 'data-source-1')
const commandId = (value: string) => decode(CommandId, value)
const pageId = (value: string) => decode(PageId, value)
const propertyId = (value: string) => decode(PropertyId, value)
const observedAt = '2026-05-25T00:00:00.000Z'

const queryContract = (overrides: Partial<QueryContractType> = {}) =>
  decode(QueryContract, {
    _tag: 'QueryContract',
    apiVersion: '2026-03-11',
    filter: null,
    sorts: [],
    pageSize: 2,
    highWatermark: null,
    membershipScope: 'all-data-source-rows',
    ...overrides,
  })

const dataSource = decode(DataSourceSnapshot, {
  _tag: 'DataSourceSnapshot',
  dataSourceId,
  requestId: 'request-data-source',
  observedAt,
  schemaHash: hash('s'),
})

const row = (id: PageId, seed: string) =>
  decode(RowPageSnapshot, {
    _tag: 'RowPageSnapshot',
    pageId: id,
    propertiesHash: hash(seed),
    lastEditedTime: observedAt,
    inTrash: false,
  })

const page = (id: PageId, seed: string) =>
  decode(PageSnapshot, {
    _tag: 'PageSnapshot',
    pageId: id,
    dataSourceId,
    requestId: `request-${id}`,
    observedAt,
    propertiesHash: hash(seed),
    inTrash: false,
  })

const pagePropertyItem = (id: PageId, property: PropertyId, seed: string) =>
  decode(PagePropertyItem, {
    _tag: 'PagePropertyItem',
    pageId: id,
    propertyId: property,
    itemHash: hash(seed),
    valueHash: hash(seed.toUpperCase()),
  })

const config = (
  overrides: Partial<FakeNotionDataSourceGatewayConfig> = {},
): FakeNotionDataSourceGatewayConfig => {
  const rows = [pageId('page-1'), pageId('page-2'), pageId('page-3')]

  return {
    dataSources: [dataSource],
    pages: rows.map((id, index) => ({
      snapshot: page(id, String(index + 1)),
      row: row(id, String(index + 1)),
      visibleInFilteredQueries: id !== pageId('page-3'),
    })),
    ...overrides,
  }
}

const runWithGateway = <TValue>(
  gatewayConfig: FakeNotionDataSourceGatewayConfig,
  effect: Effect.Effect<TValue, unknown, NotionDataSourceGateway>,
) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(makeFakeNotionDataSourceGatewayLayer(gatewayConfig))),
  )

describe('Notion data source gateway fake', () => {
  it('exposes the supported API contract and blocks configured version drift', async () => {
    const gatewayConfig = config({ configuredApiVersion: '2022-06-28' })

    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const gateway = yield* NotionDataSourceGateway
        expect(gateway.apiContract.apiVersion).toBe('2026-03-11')
        return yield* gateway.retrieveDataSource(dataSourceId)
      }).pipe(Effect.provide(makeFakeNotionDataSourceGatewayLayer(gatewayConfig))),
    )

    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') {
      expect(Chunk.toReadonlyArray(Cause.failures(result.cause)).at(0)).toMatchObject({
        _tag: 'NotionGatewayError',
        guard: 'ApiVersionUnsupported',
      })
    }
  })

  it('normalizes capability preflight into supported and missing capabilities', async () => {
    const gatewayConfig = config({
      apiContract: makeNotionApiContract({
        supportedCapabilities: ['data_source_retrieve', 'data_source_query'],
      }),
    })

    const result = await runWithGateway(
      gatewayConfig,
      Effect.gen(function* () {
        const gateway = yield* NotionDataSourceGateway
        return yield* gateway.preflightCapabilities({
          _tag: 'CapabilityPreflightInput',
          dataSourceId,
          requiredCapabilities: ['data_source_query', 'schema_update', 'page_trash'],
        })
      }),
    )

    expect(result.supportedCapabilities).toEqual(['data_source_query'])
    expect(result.missingCapabilities).toEqual(['schema_update', 'page_trash'])
  })

  it('streams paginated query rows through the terminal page', async () => {
    const pages = await runWithGateway(
      config(),
      Effect.gen(function* () {
        const gateway = yield* NotionDataSourceGateway
        return yield* gateway
          .queryRows({
            _tag: 'QueryRowsInput',
            dataSourceId,
            queryContract: queryContract(),
            startCursor: null,
          })
          .pipe(Stream.runCollect, Effect.map(Chunk.toReadonlyArray))
      }),
    )

    expect(pages).toHaveLength(2)
    expect(
      pages.flatMap((queryPage) => queryPage.rows.map((queriedRow) => queriedRow.pageId)),
    ).toEqual([pageId('page-1'), pageId('page-2'), pageId('page-3')])
    expect(pages.at(-1)).toMatchObject({ hasMore: false, nextCursor: null, cappedAtLimit: false })
  })

  it('streams page-property item pagination completely', async () => {
    const relation = propertyId('relation')
    const gatewayConfig = config({
      pagePropertyPageSize: 2,
      pages: [
        {
          snapshot: page(pageId('page-1'), '1'),
          row: row(pageId('page-1'), '1'),
          propertyItems: [
            {
              propertyId: relation,
              items: [
                pagePropertyItem(pageId('page-1'), relation, 'a'),
                pagePropertyItem(pageId('page-1'), relation, 'b'),
                pagePropertyItem(pageId('page-1'), relation, 'c'),
              ],
            },
          ],
        },
      ],
    })

    const pages = await runWithGateway(
      gatewayConfig,
      Effect.gen(function* () {
        const gateway = yield* NotionDataSourceGateway
        return yield* gateway
          .retrievePageProperty({
            _tag: 'RetrievePagePropertyInput',
            pageId: pageId('page-1'),
            propertyId: relation,
            startCursor: null,
          })
          .pipe(Stream.runCollect, Effect.map(Chunk.toReadonlyArray))
      }),
    )

    expect(pages.map((propertyPage) => propertyPage.items.length)).toEqual([2, 1])
    expect(pages.at(-1)).toMatchObject({ hasMore: false, nextCursor: null })
  })

  it('marks the terminal query page when the fake query cap is reached', async () => {
    const pages = await runWithGateway(
      config({ queryResultCap: 2 }),
      Effect.gen(function* () {
        const gateway = yield* NotionDataSourceGateway
        return yield* gateway
          .queryRows({
            _tag: 'QueryRowsInput',
            dataSourceId,
            queryContract: queryContract({ pageSize: 2 }),
            startCursor: null,
          })
          .pipe(Stream.runCollect, Effect.map(Chunk.toReadonlyArray))
      }),
    )

    expect(pages).toHaveLength(1)
    expect(pages[0]?.rows.map((queriedRow) => queriedRow.pageId)).toEqual([
      pageId('page-1'),
      pageId('page-2'),
    ])
    expect(pages[0]).toMatchObject({ hasMore: false, nextCursor: null, cappedAtLimit: true })
  })

  it('keeps filtered query absence separate from direct page availability', async () => {
    const filteredPageId = pageId('page-3')
    const result = await runWithGateway(
      config(),
      Effect.gen(function* () {
        const gateway = yield* NotionDataSourceGateway
        const queryPages = yield* gateway
          .queryRows({
            _tag: 'QueryRowsInput',
            dataSourceId,
            queryContract: queryContract({ membershipScope: 'explicit-filter' }),
            startCursor: null,
          })
          .pipe(Stream.runCollect, Effect.map(Chunk.toReadonlyArray))
        const direct = yield* gateway.retrievePage(filteredPageId)

        return { queryPages, direct }
      }),
    )

    expect(
      result.queryPages.flatMap((queryPage) =>
        queryPage.rows.map((queriedRow) => queriedRow.pageId),
      ),
    ).not.toContain(filteredPageId)
    expect(result.direct.pageId).toBe(filteredPageId)
    expect(result.direct.inTrash).toBe(false)
  })

  it('fails closed for permission-ambiguous direct page retrieval', async () => {
    const ambiguousPageId = pageId('page-2')
    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const gateway = yield* NotionDataSourceGateway
        return yield* gateway.retrievePage(ambiguousPageId)
      }).pipe(
        Effect.provide(
          makeFakeNotionDataSourceGatewayLayer(
            config({ permissionAmbiguousPageIds: [ambiguousPageId] }),
          ),
        ),
      ),
    )

    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') {
      expect(Chunk.toReadonlyArray(Cause.failures(result.cause)).at(0)).toMatchObject({
        _tag: 'NotionGatewayError',
        guard: 'PermissionAmbiguous',
      })
    }
  })

  it('can leave a successful property patch unverifiable for read-after-write mismatch tests', async () => {
    const targetPageId = pageId('page-1')
    const before = page(targetPageId, '1')
    const gatewayConfig = config({
      readAfterWriteMismatchPageIds: [targetPageId],
      pages: [{ snapshot: before, row: row(targetPageId, '1') }],
    })

    const result = await runWithGateway(
      gatewayConfig,
      Effect.gen(function* () {
        const gateway = yield* NotionDataSourceGateway
        const requestId = yield* gateway.patchPageProperties({
          _tag: 'PatchPagePropertiesCommand',
          commandId: commandId('command-1'),
          pageId: targetPageId,
          basePropertiesHash: before.propertiesHash,
          propertyPatch: {
            [propertyId('title')]: { _tag: 'title', plainText: 'changed' },
          },
        })
        const after = yield* gateway.retrievePage(targetPageId)

        return { requestId, after }
      }),
    )

    expect(result.requestId).toMatch(/^fake-req-/)
    expect(result.after.propertiesHash).toBe(before.propertiesHash)
  })
})
