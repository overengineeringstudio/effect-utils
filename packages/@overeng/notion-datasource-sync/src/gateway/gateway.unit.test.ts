import { Cause, Chunk, Effect, Exit, Option, Schema, Stream } from 'effect'
import { describe, expect, it } from 'vitest'

import { NotionApiError } from '@overeng/notion-effect-client'

import {
  DataSourceId,
  DataSourceSnapshot,
  CommandId,
  NotionDataSourceGateway,
  PageId,
  PagePropertyItem,
  PageSnapshot,
  PropertyId,
  PropertyName,
  QueryContract,
  RowPageSnapshot,
  canonicalHash,
  hashStoreBytes,
  makeFakeNotionDataSourceGatewayLayer,
  makeNotionDataSourceGatewayFromClient,
  makeNotionApiContract,
  pagePropertyPatchToNotion,
  queryContractHash,
  type FakeNotionDataSourceGatewayConfig,
  type NotionGatewayClient,
  type NotionGatewayPage,
  type QueryContract as QueryContractType,
} from '../mod.ts'

const decode = <TSchema extends Schema.Schema.AnyNoContext>(schema: TSchema, value: unknown) =>
  Schema.decodeUnknownSync(schema)(value)

const hash = (seed: string) => hashStoreBytes(seed)
const dataSourceId = decode(DataSourceId, 'data-source-1')
const commandId = (value: string) => decode(CommandId, value)
const pageId = (value: string) => decode(PageId, value)
const propertyId = (value: string) => decode(PropertyId, value)
const dateTimeUtc = (value: string) => decode(Schema.DateTimeUtc, value)
const observedAt = '2026-05-25T00:00:00.000Z'

const queryContract = (overrides: Record<string, unknown> = {}) =>
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

const expectGatewayFailure = (
  result: Awaited<ReturnType<typeof Effect.runPromiseExit>>,
  expected: {
    readonly operation?: string
    readonly guard?: string
  },
) => {
  expect(result._tag).toBe('Failure')
  if (result._tag === 'Failure') {
    expect(Chunk.toReadonlyArray(Cause.failures(result.cause)).at(0)).toMatchObject({
      _tag: 'NotionGatewayError',
      ...expected,
    })
  }
}

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

  it('streams high-cardinality query rows across Notion-sized pages', async () => {
    const rowCount = 250
    const rows = Array.from({ length: rowCount }, (_, index) => {
      const suffix = index.toString().padStart(3, '0')
      const id = pageId(`page-high-${suffix}`)

      return {
        snapshot: page(id, `snapshot-${suffix}`),
        row: row(id, `row-${suffix}`),
      }
    })

    const pages = await runWithGateway(
      config({ pages: rows }),
      Effect.gen(function* () {
        const gateway = yield* NotionDataSourceGateway
        return yield* gateway
          .queryRows({
            _tag: 'QueryRowsInput',
            dataSourceId,
            queryContract: queryContract({ pageSize: 100 }),
            startCursor: null,
          })
          .pipe(Stream.runCollect, Effect.map(Chunk.toReadonlyArray))
      }),
    )

    expect(pages.map((queryPage) => queryPage.rows.length)).toEqual([100, 100, 50])
    expect(
      pages.flatMap((queryPage) => queryPage.rows.map((queriedRow) => queriedRow.pageId)),
    ).toHaveLength(rowCount)
    expect(pages.at(-1)).toMatchObject({ hasMore: false, nextCursor: null, cappedAtLimit: false })
  })

  it('binds query checkpoint hashes to the full query contract identity', async () => {
    const apiContract = makeNotionApiContract()
    const baseInput = {
      _tag: 'QueryRowsInput',
      dataSourceId,
      queryContract: queryContract(),
      startCursor: null,
    } as const
    const baseHash = queryContractHash({ input: baseInput, apiVersion: apiContract.apiVersion })
    const selectFilter = {
      _tag: 'property_value',
      propertyId: propertyId('status'),
      operator: 'equals',
      value: {
        _tag: 'select',
        option: { _tag: 'CanonicalOptionValue', name: 'Todo' },
      },
    } as const
    const doneFilter = {
      ...selectFilter,
      value: {
        _tag: 'select',
        option: { _tag: 'CanonicalOptionValue', name: 'Done' },
      },
    } as const
    const compoundFilterA = {
      _tag: 'compound_hash',
      kind: 'and',
      expressionHash: hash('filter-a'),
    } as const
    const compoundFilterB = {
      _tag: 'compound_hash',
      kind: 'and',
      expressionHash: hash('filter-b'),
    } as const
    const sortRankAscending = {
      _tag: 'CanonicalNotionSort',
      propertyId: propertyId('rank'),
      direction: 'ascending',
    } as const
    const sortStatusDescending = {
      _tag: 'CanonicalNotionSort',
      propertyId: propertyId('status'),
      direction: 'descending',
    } as const
    const sortRankDescending = {
      ...sortRankAscending,
      direction: 'descending',
    } as const
    const hashFor = (contract: QueryContractType, apiVersion: string = apiContract.apiVersion) =>
      queryContractHash({ input: { ...baseInput, queryContract: contract }, apiVersion })
    const variants = [
      {
        label: 'filter value',
        queryContract: queryContract({ filter: selectFilter }),
      },
      {
        label: 'filter expression',
        queryContract: queryContract({
          filter: compoundFilterA,
        }),
      },
      {
        label: 'sort order',
        queryContract: queryContract({
          sorts: [sortRankAscending, sortStatusDescending],
        }),
      },
      {
        label: 'sort body',
        queryContract: queryContract({
          sorts: [sortRankDescending],
        }),
      },
      {
        label: 'page size',
        queryContract: queryContract({ pageSize: 1 }),
      },
      {
        label: 'query contract api version',
        queryContract: {
          ...queryContract(),
          apiVersion: '2027-01-01' as QueryContractType['apiVersion'],
        },
      },
      {
        label: 'membership',
        queryContract: queryContract({ membershipScope: 'explicit-filter' }),
      },
      {
        label: 'high watermark',
        queryContract: queryContract({ highWatermark: '2026-05-25T01:00:00.000Z' }),
      },
      {
        label: 'gateway api version',
        apiVersion: '2027-01-01',
        queryContract: queryContract(),
      },
      {
        label: 'filter value body',
        queryContract: queryContract({ filter: doneFilter }),
      },
    ]

    expect(
      variants.map(({ apiVersion, label, queryContract: variantContract }) => [
        label,
        hashFor(variantContract, apiVersion ?? apiContract.apiVersion) === baseHash,
      ]),
    ).toEqual(variants.map(({ label }) => [label, false]))
    expect(hashFor(queryContract({ filter: selectFilter }))).not.toBe(
      hashFor(queryContract({ filter: doneFilter })),
    )
    expect(hashFor(queryContract({ filter: compoundFilterA }))).not.toBe(
      hashFor(queryContract({ filter: compoundFilterB })),
    )
    expect(hashFor(queryContract({ sorts: [sortRankAscending, sortStatusDescending] }))).not.toBe(
      hashFor(queryContract({ sorts: [sortStatusDescending, sortRankAscending] })),
    )
    expect(hashFor(queryContract({ sorts: [sortRankAscending] }))).not.toBe(
      hashFor(queryContract({ sorts: [sortRankDescending] })),
    )
  })

  it('emits query pages with contract hashes that change with the gateway API version', async () => {
    const gatewayApiVersion = '2027-01-01' as ReturnType<typeof makeNotionApiContract>['apiVersion']
    const futureApiContract = {
      ...makeNotionApiContract(),
      apiVersion: gatewayApiVersion,
    }
    const [currentPage, futurePage] = await Promise.all(
      [
        config(),
        config({ apiContract: futureApiContract, configuredApiVersion: '2026-03-11' }),
      ].map((gatewayConfig) =>
        runWithGateway(
          gatewayConfig,
          Effect.gen(function* () {
            const gateway = yield* NotionDataSourceGateway
            return yield* gateway
              .queryRows({
                _tag: 'QueryRowsInput',
                dataSourceId,
                queryContract: queryContract(),
                startCursor: null,
              })
              .pipe(
                Stream.runCollect,
                Effect.map((chunk) => Chunk.toReadonlyArray(chunk)[0]),
              )
          }),
        ),
      ),
    )

    expect(currentPage?.queryContractHash).not.toBe(futurePage?.queryContractHash)
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

  it('streams high-cardinality page-property items across Notion-sized pages', async () => {
    const relation = propertyId('relation')
    const itemCount = 251
    const items = Array.from({ length: itemCount }, (_, index) =>
      pagePropertyItem(pageId('page-1'), relation, `relation-${index.toString().padStart(3, '0')}`),
    )
    const gatewayConfig = config({
      pagePropertyPageSize: 100,
      pages: [
        {
          snapshot: page(pageId('page-1'), '1'),
          row: row(pageId('page-1'), '1'),
          propertyItems: [{ propertyId: relation, items }],
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

    expect(pages.map((propertyPage) => propertyPage.items.length)).toEqual([100, 100, 51])
    expect(pages.flatMap((propertyPage) => propertyPage.items)).toHaveLength(itemCount)
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

  it('fails closed when querying a missing data source instead of emitting an empty scan', async () => {
    const missingDataSourceId = decode(DataSourceId, 'missing-data-source')
    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const gateway = yield* NotionDataSourceGateway
        return yield* gateway
          .queryRows({
            _tag: 'QueryRowsInput',
            dataSourceId: missingDataSourceId,
            queryContract: queryContract(),
            startCursor: null,
          })
          .pipe(Stream.runCollect)
      }).pipe(Effect.provide(makeFakeNotionDataSourceGatewayLayer(config()))),
    )

    expectGatewayFailure(result, { operation: 'queryRows', guard: 'PermissionAmbiguous' })
  })

  it('fails closed when query data source access is permission ambiguous', async () => {
    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const gateway = yield* NotionDataSourceGateway
        return yield* gateway
          .queryRows({
            _tag: 'QueryRowsInput',
            dataSourceId,
            queryContract: queryContract(),
            startCursor: null,
          })
          .pipe(Stream.runCollect)
      }).pipe(
        Effect.provide(
          makeFakeNotionDataSourceGatewayLayer(
            config({ permissionAmbiguousDataSourceIds: [dataSourceId] }),
          ),
        ),
      ),
    )

    expectGatewayFailure(result, { operation: 'queryRows', guard: 'PermissionAmbiguous' })
  })

  it('rejects invalid query page sizes before pagination starts', async () => {
    await Promise.all(
      [0, -1].map(async (pageSize) => {
        const result = await Effect.runPromiseExit(
          Effect.gen(function* () {
            const gateway = yield* NotionDataSourceGateway
            return yield* gateway
              .queryRows({
                _tag: 'QueryRowsInput',
                dataSourceId,
                queryContract: {
                  ...queryContract(),
                  pageSize: pageSize as QueryContractType['pageSize'],
                },
                startCursor: null,
              })
              .pipe(Stream.runCollect)
          }).pipe(Effect.provide(makeFakeNotionDataSourceGatewayLayer(config()))),
        )

        expectGatewayFailure(result, { operation: 'queryRows', guard: 'UnsupportedRemoteShape' })
      }),
    )
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

    expectGatewayFailure(result, { operation: 'retrievePage', guard: 'PermissionAmbiguous' })
  })

  it('fails closed for missing page-property surfaces', async () => {
    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const gateway = yield* NotionDataSourceGateway
        return yield* gateway
          .retrievePageProperty({
            _tag: 'RetrievePagePropertyInput',
            pageId: pageId('page-1'),
            propertyId: propertyId('missing-property'),
            startCursor: null,
          })
          .pipe(Stream.runCollect)
      }).pipe(Effect.provide(makeFakeNotionDataSourceGatewayLayer(config()))),
    )

    expectGatewayFailure(result, {
      operation: 'retrievePageProperty',
      guard: 'CurrentSurfaceMissing',
    })
  })

  it('fails closed for permission-ambiguous page-property pages', async () => {
    const ambiguousPageId = pageId('page-1')
    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const gateway = yield* NotionDataSourceGateway
        return yield* gateway
          .retrievePageProperty({
            _tag: 'RetrievePagePropertyInput',
            pageId: ambiguousPageId,
            propertyId: propertyId('relation'),
            startCursor: null,
          })
          .pipe(Stream.runCollect)
      }).pipe(
        Effect.provide(
          makeFakeNotionDataSourceGatewayLayer(
            config({ permissionAmbiguousPageIds: [ambiguousPageId] }),
          ),
        ),
      ),
    )

    expectGatewayFailure(result, {
      operation: 'retrievePageProperty',
      guard: 'PermissionAmbiguous',
    })
  })

  it('fails closed for missing page-property pages', async () => {
    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const gateway = yield* NotionDataSourceGateway
        return yield* gateway
          .retrievePageProperty({
            _tag: 'RetrievePagePropertyInput',
            pageId: pageId('missing-page'),
            propertyId: propertyId('relation'),
            startCursor: null,
          })
          .pipe(Stream.runCollect)
      }).pipe(Effect.provide(makeFakeNotionDataSourceGatewayLayer(config()))),
    )

    expectGatewayFailure(result, {
      operation: 'retrievePageProperty',
      guard: 'PermissionAmbiguous',
    })
  })

  it('rejects invalid page-property page sizes before pagination starts', async () => {
    await Promise.all(
      [0, -1].map(async (pagePropertyPageSize) => {
        const relation = propertyId('relation')
        const result = await Effect.runPromiseExit(
          Effect.gen(function* () {
            const gateway = yield* NotionDataSourceGateway
            return yield* gateway
              .retrievePageProperty({
                _tag: 'RetrievePagePropertyInput',
                pageId: pageId('page-1'),
                propertyId: relation,
                startCursor: null,
              })
              .pipe(Stream.runCollect)
          }).pipe(
            Effect.provide(
              makeFakeNotionDataSourceGatewayLayer(
                config({
                  pagePropertyPageSize,
                  pages: [
                    {
                      snapshot: page(pageId('page-1'), '1'),
                      row: row(pageId('page-1'), '1'),
                      propertyItems: [
                        {
                          propertyId: relation,
                          items: [pagePropertyItem(pageId('page-1'), relation, 'a')],
                        },
                      ],
                    },
                  ],
                }),
              ),
            ),
          ),
        )

        expectGatewayFailure(result, {
          operation: 'retrievePageProperty',
          guard: 'UnsupportedRemoteShape',
        })
      }),
    )
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

  it('rejects stale trash commands', async () => {
    const targetPageId = pageId('page-1')
    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const gateway = yield* NotionDataSourceGateway
        return yield* gateway.trashPage({
          _tag: 'TrashPageCommand',
          commandId: commandId('command-trash'),
          pageId: targetPageId,
          basePropertiesHash: hash('stale'),
        })
      }).pipe(Effect.provide(makeFakeNotionDataSourceGatewayLayer(config()))),
    )

    expectGatewayFailure(result, { operation: 'trashPage', guard: 'StaleSurfaceBase' })
  })

  it('rejects stale restore commands', async () => {
    const targetPageId = pageId('page-1')
    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const gateway = yield* NotionDataSourceGateway
        return yield* gateway.restorePage({
          _tag: 'RestorePageCommand',
          commandId: commandId('command-restore'),
          pageId: targetPageId,
          basePropertiesHash: hash('stale'),
        })
      }).pipe(Effect.provide(makeFakeNotionDataSourceGatewayLayer(config()))),
    )

    expectGatewayFailure(result, { operation: 'restorePage', guard: 'StaleSurfaceBase' })
  })

  it('applies supported schema operations and rejects empty operation lists fail-closed', async () => {
    const gatewayConfig = config()

    const success = await runWithGateway(
      gatewayConfig,
      Effect.gen(function* () {
        const gateway = yield* NotionDataSourceGateway
        const requestId = yield* gateway.patchDataSourceSchema({
          _tag: 'PatchDataSourceSchemaCommand',
          commandId: commandId('command-schema-1'),
          dataSourceId,
          baseSchemaHash: dataSource.schemaHash,
          schemaPatch: {},
          operations: [
            {
              _tag: 'AddProperty',
              name: decode(PropertyName, 'Notes'),
              definition: { _tag: 'rich_text' },
            },
          ],
        })
        const after = yield* gateway.retrieveDataSource(dataSourceId)
        return { requestId, after }
      }),
    )
    const empty = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const gateway = yield* NotionDataSourceGateway
        return yield* gateway.patchDataSourceSchema({
          _tag: 'PatchDataSourceSchemaCommand',
          commandId: commandId('command-schema-empty'),
          dataSourceId,
          baseSchemaHash: dataSource.schemaHash,
          schemaPatch: {},
          operations: [],
        })
      }).pipe(Effect.provide(makeFakeNotionDataSourceGatewayLayer(gatewayConfig))),
    )

    expect(success.requestId).toMatch(/^fake-req-/)
    expect(success.after.schemaHash).not.toBe(dataSource.schemaHash)
    expectGatewayFailure(empty, {
      operation: 'patchDataSourceSchema',
      guard: 'UnsupportedRemoteShape',
    })
  })

  it('patches data source metadata independently from schema hash and rejects stale bases', async () => {
    const metadataDataSource = decode(DataSourceSnapshot, {
      _tag: 'DataSourceSnapshot',
      dataSourceId,
      requestId: 'request-metadata',
      observedAt,
      schemaHash: hash('schema-stable'),
      metadataHash: hash('metadata-before'),
    })
    const gatewayConfig = config({ dataSources: [metadataDataSource] })
    const success = await runWithGateway(
      gatewayConfig,
      Effect.gen(function* () {
        const gateway = yield* NotionDataSourceGateway
        const requestId = yield* gateway.patchDataSourceMetadata({
          _tag: 'PatchDataSourceMetadataCommand',
          commandId: commandId('command-metadata'),
          dataSourceId,
          baseMetadataHash: metadataDataSource.metadataHash,
          metadataPatch: { descriptionPlainText: 'Updated description' },
        })
        const after = yield* gateway.retrieveDataSource(dataSourceId)
        return { requestId, after }
      }),
    )
    const stale = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const gateway = yield* NotionDataSourceGateway
        return yield* gateway.patchDataSourceMetadata({
          _tag: 'PatchDataSourceMetadataCommand',
          commandId: commandId('command-metadata-stale'),
          dataSourceId,
          baseMetadataHash: hash('stale-metadata'),
          metadataPatch: { descriptionPlainText: 'Stale description' },
        })
      }).pipe(Effect.provide(makeFakeNotionDataSourceGatewayLayer(gatewayConfig))),
    )

    expect(success.requestId).toMatch(/^fake-req-/)
    expect(success.after.schemaHash).toBe(metadataDataSource.schemaHash)
    expect(success.after.metadataHash).not.toBe(metadataDataSource.metadataHash)
    expectGatewayFailure(stale, {
      operation: 'patchDataSourceMetadata',
      guard: 'StaleSurfaceBase',
    })
  })
})

describe('Notion data source gateway real adapter boundary', () => {
  const remotePage = (id: PageId, properties: Record<string, unknown> = {}): NotionGatewayPage => ({
    id,
    parent: { type: 'data_source_id', data_source_id: dataSourceId },
    properties,
    last_edited_time: observedAt,
    in_trash: false,
  })
  const remoteDataSource = {
    id: dataSourceId,
    title: [{ type: 'text', plain_text: 'Tasks', text: { content: 'Tasks' } }],
    description: [
      { type: 'text', plain_text: 'Old description', text: { content: 'Old description' } },
    ],
    icon: null,
    parent: { type: 'database_id' as const, database_id: 'database-1' },
    properties: {
      title: { id: 'title', name: 'Name', type: 'title' },
    },
  }

  const makeClient = (overrides: Partial<NotionGatewayClient> = {}): NotionGatewayClient => ({
    retrieveDataSource: () => Effect.succeed(remoteDataSource),
    queryDataSource: () =>
      Effect.succeed({
        results: [remotePage(pageId('page-1'), { title: { type: 'title' } })],
        nextCursor: Option.none(),
        hasMore: false,
      }),
    retrievePage: () => Effect.succeed(remotePage(pageId('page-1'), { title: { type: 'title' } })),
    retrievePageProperty: () =>
      Effect.succeed({
        results: [],
        nextCursor: Option.none(),
        hasMore: false,
      }),
    retrieveDatabase: () =>
      Effect.succeed({
        id: 'database-1',
        title: remoteDataSource.title,
        description: remoteDataSource.description,
        icon: null,
      }),
    updatePage: () => Effect.succeed(remotePage(pageId('page-1'), { title: { type: 'title' } })),
    updateDatabase: () =>
      Effect.succeed({
        id: 'database-1',
        title: remoteDataSource.title,
        description: remoteDataSource.description,
        icon: null,
      }),
    updateDataSource: () => Effect.succeed(remoteDataSource),
    ...overrides,
  })

  it('maps data source retrieval, query, and page property updates to the local Notion client shape', async () => {
    const queryCalls: Array<Parameters<NotionGatewayClient['queryDataSource']>[0]> = []
    const updatePageCalls: Array<Parameters<NotionGatewayClient['updatePage']>[0]> = []
    const targetPageId = pageId('page-1')
    const pageBefore = remotePage(targetPageId, { title: { type: 'title', title: [] } })
    const client = makeClient({
      queryDataSource: (input) =>
        Effect.sync(() => queryCalls.push(input)).pipe(
          Effect.as({
            results: [remotePage(targetPageId, { title: { type: 'title', title: [] } })],
            nextCursor: Option.none(),
            hasMore: false,
          }),
        ),
      retrievePage: ({ pageId: id }) =>
        Effect.succeed(remotePage(PageId.make(id), pageBefore.properties)),
      updatePage: (input) =>
        Effect.sync(() => updatePageCalls.push(input)).pipe(Effect.as(pageBefore)),
    })
    const gateway = makeNotionDataSourceGatewayFromClient({ client })
    const pageSnapshot = await Effect.runPromise(gateway.retrievePage(targetPageId))
    const queryPages = await Effect.runPromise(
      gateway
        .queryRows({
          _tag: 'QueryRowsInput',
          dataSourceId,
          queryContract: queryContract({ pageSize: 1 }),
          startCursor: null,
        })
        .pipe(Stream.runCollect, Effect.map(Chunk.toReadonlyArray)),
    )
    const requestId = await Effect.runPromise(
      gateway.patchPageProperties({
        _tag: 'PatchPagePropertiesCommand',
        commandId: commandId('command-real-patch'),
        pageId: targetPageId,
        basePropertiesHash: pageSnapshot.propertiesHash,
        propertyPatch: {
          [propertyId('title')]: { _tag: 'title', plainText: 'Updated title' },
          [propertyId('done')]: { _tag: 'checkbox', checked: true },
        },
      }),
    )

    expect(queryCalls).toEqual([
      {
        dataSourceId,
        pageSize: 1,
        startCursor: undefined,
        filter: undefined,
        sorts: undefined,
      },
    ])
    expect(queryPages).toHaveLength(1)
    expect(queryPages[0]?.rows.map((queriedRow) => queriedRow.pageId)).toEqual([targetPageId])
    expect(updatePageCalls).toEqual([
      {
        pageId: targetPageId,
        properties: {
          [propertyId('title')]: {
            title: [{ type: 'text', text: { content: 'Updated title' } }],
          },
          [propertyId('done')]: { checkbox: true },
        },
      },
    ])
    expect(requestId).toBe('notion-client-success-request-id-unavailable')
  })

  it('preserves paginated page-property list metadata separately from relation item count', async () => {
    const relation = propertyId('relation')
    const propertyItem = {
      id: relation,
      type: 'rollup',
      rollup: { type: 'number', number: 2, function: 'count' },
      next_url: null,
    }
    const gateway = makeNotionDataSourceGatewayFromClient({
      client: makeClient({
        retrievePageProperty: () =>
          Effect.succeed({
            results: [
              {
                object: 'property_item',
                id: relation,
                type: 'relation',
                relation: { id: pageId('related-page-1') },
              },
            ],
            propertyItem,
            nextCursor: Option.none(),
            hasMore: false,
          }),
      }),
    })

    const pages = await Effect.runPromise(
      gateway
        .retrievePageProperty({
          _tag: 'RetrievePagePropertyInput',
          pageId: pageId('page-1'),
          propertyId: relation,
          startCursor: null,
        })
        .pipe(Stream.runCollect, Effect.map(Chunk.toReadonlyArray)),
    )

    expect(pages).toHaveLength(1)
    expect(pages[0]?.items).toHaveLength(1)
    expect(pages[0]?.listMetadataHash).toBe(canonicalHash(propertyItem))
  })

  it('encodes the supported writable Notion page property matrix', async () => {
    const patch = await Effect.runPromise(
      pagePropertyPatchToNotion({
        [propertyId('title')]: { _tag: 'title', plainText: 'Task title' },
        [propertyId('rich')]: { _tag: 'rich_text', plainText: 'Longer note' },
        [propertyId('number')]: { _tag: 'number', value: 42 },
        [propertyId('checkbox')]: { _tag: 'checkbox', checked: true },
        [propertyId('date')]: {
          _tag: 'date',
          start: dateTimeUtc('2026-05-25T10:00:00.000Z'),
          end: dateTimeUtc('2026-05-26T10:00:00.000Z'),
        },
        [propertyId('select')]: {
          _tag: 'select',
          option: {
            _tag: 'CanonicalOptionValue',
            id: propertyId('opt-1'),
            name: decode(PropertyName, 'Doing'),
          },
        },
        [propertyId('select-null')]: { _tag: 'select', option: null },
        [propertyId('multi')]: {
          _tag: 'multi_select',
          options: [
            { _tag: 'CanonicalOptionValue', name: decode(PropertyName, 'Backend') },
            {
              _tag: 'CanonicalOptionValue',
              id: propertyId('opt-2'),
              name: decode(PropertyName, 'API'),
              color: 'blue',
            },
          ],
        },
        [propertyId('status')]: {
          _tag: 'status',
          option: { _tag: 'CanonicalOptionValue', name: decode(PropertyName, 'In progress') },
        },
        [propertyId('relation')]: {
          _tag: 'relation',
          pageIds: [pageId('related-page-1'), pageId('related-page-2')],
        },
        [propertyId('people')]: { _tag: 'people', userIds: ['user-1', 'user-2'] },
        [propertyId('email')]: { _tag: 'email', value: 'ada@example.com' },
        [propertyId('url')]: { _tag: 'url', value: 'https://developers.notion.com/' },
        [propertyId('phone')]: { _tag: 'phone_number', value: '+1 555 0100' },
        [propertyId('email-null')]: { _tag: 'email', value: null },
        [propertyId('url-null')]: { _tag: 'url', value: null },
        [propertyId('phone-null')]: { _tag: 'phone_number', value: null },
      }),
    )

    expect(patch).toEqual({
      [propertyId('title')]: { title: [{ type: 'text', text: { content: 'Task title' } }] },
      [propertyId('rich')]: { rich_text: [{ type: 'text', text: { content: 'Longer note' } }] },
      [propertyId('number')]: { number: 42 },
      [propertyId('checkbox')]: { checkbox: true },
      [propertyId('date')]: {
        date: {
          start: '2026-05-25T10:00:00.000Z',
          end: '2026-05-26T10:00:00.000Z',
        },
      },
      [propertyId('select')]: { select: { id: propertyId('opt-1'), name: 'Doing' } },
      [propertyId('select-null')]: { select: null },
      [propertyId('multi')]: {
        multi_select: [
          { name: 'Backend' },
          { id: propertyId('opt-2'), name: 'API', color: 'blue' },
        ],
      },
      [propertyId('status')]: { status: { name: 'In progress' } },
      [propertyId('relation')]: {
        relation: [{ id: pageId('related-page-1') }, { id: pageId('related-page-2') }],
      },
      [propertyId('people')]: { people: [{ id: 'user-1' }, { id: 'user-2' }] },
      [propertyId('email')]: { email: 'ada@example.com' },
      [propertyId('url')]: { url: 'https://developers.notion.com/' },
      [propertyId('phone')]: { phone_number: '+1 555 0100' },
      [propertyId('email-null')]: { email: null },
      [propertyId('url-null')]: { url: null },
      [propertyId('phone-null')]: { phone_number: null },
    })
  })

  it('keeps missing adapter capabilities explicit instead of pretending unsupported endpoints exist', async () => {
    const gateway = makeNotionDataSourceGatewayFromClient({ client: makeClient() })

    const preflight = await Effect.runPromise(
      gateway.preflightCapabilities({
        _tag: 'CapabilityPreflightInput',
        dataSourceId,
        requiredCapabilities: ['data_source_retrieve', 'page_property_paginate'],
      }),
    )
    const propertyResult = await Effect.runPromiseExit(
      gateway
        .retrievePageProperty({
          _tag: 'RetrievePagePropertyInput',
          pageId: pageId('page-1'),
          propertyId: propertyId('relation'),
          startCursor: null,
        })
        .pipe(Stream.runCollect),
    )

    expect(preflight.missingCapabilities).toEqual([])
    expect(Exit.isSuccess(propertyResult)).toBe(true)
  })

  it('fails closed when a schema patch has no supported operations and never reaches updateDataSource', async () => {
    const updateDataSourceCalls: Array<Parameters<NotionGatewayClient['updateDataSource']>[0]> = []
    const remoteSchemaHash = canonicalHash(remoteDataSource.properties)
    const gateway = makeNotionDataSourceGatewayFromClient({
      client: makeClient({
        updateDataSource: (input) =>
          Effect.sync(() => updateDataSourceCalls.push(input)).pipe(Effect.as(remoteDataSource)),
      }),
    })

    const result = await Effect.runPromiseExit(
      gateway.patchDataSourceSchema({
        _tag: 'PatchDataSourceSchemaCommand',
        commandId: commandId('command-schema-empty'),
        dataSourceId,
        baseSchemaHash: remoteSchemaHash,
        schemaPatch: {},
        operations: [],
      }),
    )

    expectGatewayFailure(result, {
      operation: 'patchDataSourceSchema',
      guard: 'UnsupportedRemoteShape',
    })
    expect(updateDataSourceCalls).toEqual([])
  })

  it('translates the supported schema operation subset into a single updateDataSource call', async () => {
    const updateDataSourceCalls: Array<Parameters<NotionGatewayClient['updateDataSource']>[0]> = []
    const remoteSchemaHash = canonicalHash(remoteDataSource.properties)
    const gateway = makeNotionDataSourceGatewayFromClient({
      client: makeClient({
        updateDataSource: (input) =>
          Effect.sync(() => updateDataSourceCalls.push(input)).pipe(Effect.as(remoteDataSource)),
      }),
    })

    const requestId = await Effect.runPromise(
      gateway.patchDataSourceSchema({
        _tag: 'PatchDataSourceSchemaCommand',
        commandId: commandId('command-schema-ok'),
        dataSourceId,
        baseSchemaHash: remoteSchemaHash,
        schemaPatch: {},
        operations: [
          {
            _tag: 'AddProperty',
            name: decode(PropertyName, 'Notes'),
            definition: { _tag: 'rich_text' },
          },
          {
            _tag: 'RenameProperty',
            propertyId: propertyId('title'),
            newName: decode(PropertyName, 'Task'),
          },
          {
            _tag: 'AddProperty',
            name: decode(PropertyName, 'Stage'),
            definition: {
              _tag: 'select',
              options: [
                { _tag: 'CanonicalOptionValue', name: decode(PropertyName, 'Todo') },
                {
                  _tag: 'CanonicalOptionValue',
                  name: decode(PropertyName, 'Doing'),
                  color: 'blue',
                },
              ],
            },
          },
          {
            _tag: 'AddSelectOptions',
            propertyId: propertyId('priority'),
            propertyType: 'multi_select',
            existingOptions: [
              {
                _tag: 'CanonicalOptionValue',
                id: propertyId('opt-high'),
                name: decode(PropertyName, 'High'),
              },
              { _tag: 'CanonicalOptionValue', name: decode(PropertyName, 'Low') },
            ],
            newOptions: [
              {
                _tag: 'CanonicalOptionValue',
                name: decode(PropertyName, 'Medium'),
                color: 'yellow',
              },
            ],
          },
        ],
      }),
    )

    expect(updateDataSourceCalls).toEqual([
      {
        dataSourceId,
        properties: {
          Notes: { rich_text: {} },
          [propertyId('title')]: { name: 'Task' },
          Stage: {
            select: {
              options: [{ name: 'Todo' }, { name: 'Doing', color: 'blue' }],
            },
          },
          [propertyId('priority')]: {
            multi_select: {
              options: [
                { id: propertyId('opt-high'), name: 'High' },
                { name: 'Low' },
                { name: 'Medium', color: 'yellow' },
              ],
            },
          },
        },
      },
    ])
    expect(requestId).toBe('notion-client-success-request-id-unavailable')
  })

  it('translates metadata description patches into an owning database update payload', async () => {
    const updateDatabaseCalls: Array<Parameters<NotionGatewayClient['updateDatabase']>[0]> = []
    const baseMetadataHash = canonicalHash({
      _tag: 'CanonicalDataSourceMetadata',
      titlePlainText: 'Tasks',
      descriptionPlainText: 'Old description',
      icon: { _tag: 'none' },
    })
    const gateway = makeNotionDataSourceGatewayFromClient({
      client: makeClient({
        updateDatabase: (input) =>
          Effect.sync(() => updateDatabaseCalls.push(input)).pipe(
            Effect.as({
              id: input.databaseId,
              title: remoteDataSource.title,
              description: input.description ?? remoteDataSource.description,
              icon: null,
            }),
          ),
      }),
    })

    const requestId = await Effect.runPromise(
      gateway.patchDataSourceMetadata({
        _tag: 'PatchDataSourceMetadataCommand',
        commandId: commandId('command-metadata-real'),
        dataSourceId,
        baseMetadataHash,
        metadataPatch: {
          descriptionPlainText: 'Synced description',
        },
      }),
    )

    expect(updateDatabaseCalls).toEqual([
      {
        databaseId: 'database-1',
        description: [{ type: 'text', text: { content: 'Synced description' } }],
      },
    ])
    expect(requestId).toBe('notion-client-success-request-id-unavailable')
  })

  it('fails closed when AddSelectOptions has empty newOptions and does not call updateDataSource', async () => {
    const updateDataSourceCalls: Array<Parameters<NotionGatewayClient['updateDataSource']>[0]> = []
    const remoteSchemaHash = canonicalHash(remoteDataSource.properties)
    const gateway = makeNotionDataSourceGatewayFromClient({
      client: makeClient({
        updateDataSource: (input) =>
          Effect.sync(() => updateDataSourceCalls.push(input)).pipe(Effect.as(remoteDataSource)),
      }),
    })

    const result = await Effect.runPromiseExit(
      gateway.patchDataSourceSchema({
        _tag: 'PatchDataSourceSchemaCommand',
        commandId: commandId('command-schema-empty-new'),
        dataSourceId,
        baseSchemaHash: remoteSchemaHash,
        schemaPatch: {},
        operations: [
          {
            _tag: 'AddSelectOptions',
            propertyId: propertyId('priority'),
            propertyType: 'select',
            existingOptions: [{ _tag: 'CanonicalOptionValue', name: decode(PropertyName, 'High') }],
            newOptions: [],
          },
        ],
      }),
    )

    expectGatewayFailure(result, {
      operation: 'patchDataSourceSchema',
      guard: 'UnsupportedRemoteShape',
    })
    expect(updateDataSourceCalls).toEqual([])
  })

  it('fails closed when AddSelectOptions tries to add a name that already exists', async () => {
    const updateDataSourceCalls: Array<Parameters<NotionGatewayClient['updateDataSource']>[0]> = []
    const remoteSchemaHash = canonicalHash(remoteDataSource.properties)
    const gateway = makeNotionDataSourceGatewayFromClient({
      client: makeClient({
        updateDataSource: (input) =>
          Effect.sync(() => updateDataSourceCalls.push(input)).pipe(Effect.as(remoteDataSource)),
      }),
    })

    const result = await Effect.runPromiseExit(
      gateway.patchDataSourceSchema({
        _tag: 'PatchDataSourceSchemaCommand',
        commandId: commandId('command-schema-dup-name'),
        dataSourceId,
        baseSchemaHash: remoteSchemaHash,
        schemaPatch: {},
        operations: [
          {
            _tag: 'AddSelectOptions',
            propertyId: propertyId('priority'),
            propertyType: 'select',
            existingOptions: [{ _tag: 'CanonicalOptionValue', name: decode(PropertyName, 'High') }],
            newOptions: [{ _tag: 'CanonicalOptionValue', name: decode(PropertyName, 'High') }],
          },
        ],
      }),
    )

    expectGatewayFailure(result, {
      operation: 'patchDataSourceSchema',
      guard: 'UnsupportedRemoteShape',
    })
    expect(updateDataSourceCalls).toEqual([])
  })

  it('rejects ambiguous schema patches that target the same property key twice without calling Notion', async () => {
    const updateDataSourceCalls: Array<Parameters<NotionGatewayClient['updateDataSource']>[0]> = []
    const remoteSchemaHash = canonicalHash(remoteDataSource.properties)
    const gateway = makeNotionDataSourceGatewayFromClient({
      client: makeClient({
        updateDataSource: (input) =>
          Effect.sync(() => updateDataSourceCalls.push(input)).pipe(Effect.as(remoteDataSource)),
      }),
    })

    const result = await Effect.runPromiseExit(
      gateway.patchDataSourceSchema({
        _tag: 'PatchDataSourceSchemaCommand',
        commandId: commandId('command-schema-conflict'),
        dataSourceId,
        baseSchemaHash: remoteSchemaHash,
        schemaPatch: {},
        operations: [
          {
            _tag: 'RenameProperty',
            propertyId: propertyId('title'),
            newName: decode(PropertyName, 'A'),
          },
          {
            _tag: 'RenameProperty',
            propertyId: propertyId('title'),
            newName: decode(PropertyName, 'B'),
          },
        ],
      }),
    )

    expectGatewayFailure(result, {
      operation: 'patchDataSourceSchema',
      guard: 'UnsupportedRemoteShape',
    })
    expect(updateDataSourceCalls).toEqual([])
  })

  it('fails closed when the schema base hash has drifted before updateDataSource is invoked', async () => {
    const updateDataSourceCalls: Array<Parameters<NotionGatewayClient['updateDataSource']>[0]> = []
    const gateway = makeNotionDataSourceGatewayFromClient({
      client: makeClient({
        updateDataSource: (input) =>
          Effect.sync(() => updateDataSourceCalls.push(input)).pipe(Effect.as(remoteDataSource)),
      }),
    })

    const result = await Effect.runPromiseExit(
      gateway.patchDataSourceSchema({
        _tag: 'PatchDataSourceSchemaCommand',
        commandId: commandId('command-schema-stale'),
        dataSourceId,
        baseSchemaHash: hash('stale-schema'),
        schemaPatch: {},
        operations: [
          {
            _tag: 'RenameProperty',
            propertyId: propertyId('title'),
            newName: decode(PropertyName, 'Renamed'),
          },
        ],
      }),
    )

    expectGatewayFailure(result, {
      operation: 'patchDataSourceSchema',
      guard: 'StaleSurfaceBase',
    })
    expect(updateDataSourceCalls).toEqual([])
  })

  it('preserves fail-closed Notion 403/404 permission ambiguity semantics', async () => {
    const gateway = makeNotionDataSourceGatewayFromClient({
      client: makeClient({
        retrieveDataSource: () =>
          Effect.fail(
            new NotionApiError({
              status: 404,
              code: 'object_not_found',
              message: 'Could not find data source',
              retryAfterSeconds: Option.none(),
              requestId: Option.some('notion-request-1'),
              url: Option.some('https://api.notion.com/v1/data_sources/missing'),
              method: Option.some('GET'),
            }),
          ),
      }),
    })

    const result = await Effect.runPromiseExit(gateway.retrieveDataSource(dataSourceId))

    expectGatewayFailure(result, {
      operation: 'retrieveDataSource',
      guard: 'PermissionAmbiguous',
    })
  })

  it('rejects computed and incomplete property writes before issuing a page update', async () => {
    const computedResult = await Effect.runPromiseExit(
      pagePropertyPatchToNotion({
        [propertyId('formula')]: { _tag: 'computed', valueHash: hash('formula') },
      }),
    )
    const incompleteResult = await Effect.runPromiseExit(
      pagePropertyPatchToNotion({
        [propertyId('files')]: { _tag: 'files', files: [] },
      }),
    )

    expectGatewayFailure(computedResult, {
      operation: 'patchPageProperties',
      guard: 'ComputedPropertyWrite',
    })
    expectGatewayFailure(incompleteResult, {
      operation: 'patchPageProperties',
      guard: 'UnsupportedRemoteShape',
    })
  })
})
