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
  queryContractHash,
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

  it('binds query checkpoint hashes to the full query contract identity', async () => {
    const apiContract = makeNotionApiContract()
    const baseInput = {
      _tag: 'QueryRowsInput',
      dataSourceId,
      queryContract: queryContract(),
      startCursor: null,
    } as const
    const baseHash = queryContractHash(baseInput, apiContract.apiVersion)
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
      queryContractHash({ ...baseInput, queryContract: contract }, apiVersion)
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
})
