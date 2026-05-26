import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FetchHttpClient, type HttpClient } from '@effect/platform'
import { Effect, Layer, Option, Redacted, Schema, Stream } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  type NotionConfig,
  NotionConfigLive,
  NotionDataSources,
  NotionDatabases,
  NotionPages,
} from '@overeng/notion-effect-client'
import { NotionMdGateway, NotionMdGatewayLive } from '@overeng/notion-md'

import {
  CommandId,
  DataSourceId,
  Hash,
  makeNotionApiContract,
  makeNotionDataSourceGatewayFromClient,
  makeNotionDataSourceGatewayLayer,
  makeNotionEffectClientGatewayClient,
  makeNotionMdPageBodySyncPort,
  NotionDataSourceGateway,
  NotionDataSourceGatewayLive,
  type NotionGatewayClient,
  type NotionDataSourceGatewayShape,
  PageBodySyncPort,
  PageId,
  PropertyId,
  PropertyName,
  SchemaPatchOperation,
  WorkspaceRelativePath,
} from '../mod.ts'
import { makeFakeGatewayHarness, testIds } from '../testing/harness.ts'
import {
  emptyLiveFixtureLedger,
  defaultLivePreflightCapabilities,
  ledgerEntry,
  LiveFixtureCleanupError,
  liveNotionConfigFromEnv,
  liveNotionEnvFromProcessEnv,
  makeLiveFixtureLedgerWriter,
  makeLiveNotionFixtureLifecycleClient,
  provisionLiveNotionDataSourceFixture,
  runLiveFixtureLifecycle,
  runLiveFixtureSoak,
  runLiveNotionDemoShowcase,
  runLiveNotionPreflight,
  strictLivePreflightCapabilities,
  type LiveFixtureLedger,
  type LiveFixtureLifecycleClient,
} from '../testing/live-notion.ts'
import { scenarioImplementationGaps, type ScenarioId } from '../testing/scenarios.ts'

const processLiveConfig = liveNotionConfigFromEnv(liveNotionEnvFromProcessEnv())
const implementedLiveScenarioIds = new Set<ScenarioId>([
  'NDS-LIVE-skeleton-gated-cleanup-ledger',
  'NDS-LIVE-bounded-fixture-soak',
])

const decode = <TSchema extends Schema.Schema.AnyNoContext>(
  schema: TSchema,
  value: unknown,
): typeof schema.Type => Schema.decodeUnknownSync(schema)(value)

const sha256Hash = (value: string) =>
  decode(Hash, `sha256:${createHash('sha256').update(value).digest('hex')}`)

const text = (content: string) => ({ type: 'text', text: { content } })
const title = (content: string) => ({ title: [text(content)] })

const liveLayer = (token: string) =>
  Layer.mergeAll(
    NotionConfigLive({
      authToken: Redacted.make(token),
      retryEnabled: true,
      maxRetries: 2,
      retryBaseDelay: 500,
    }),
    FetchHttpClient.layer,
  )

const runLive = <A, E>(
  env: { readonly token: string | undefined },
  effect: Effect.Effect<A, E, NotionConfig | HttpClient.HttpClient>,
) => {
  if (env.token === undefined) {
    throw new Error('live Notion test requires a token after configuration validation')
  }

  return Effect.runPromise(effect.pipe(Effect.provide(liveLayer(env.token))))
}

const runLiveGateway = <A, E>(
  env: { readonly token: string | undefined },
  effect: Effect.Effect<A, E, NotionDataSourceGateway | NotionConfig | HttpClient.HttpClient>,
) => {
  if (env.token === undefined) {
    throw new Error('live Notion gateway test requires a token after configuration validation')
  }

  const baseLayer = liveLayer(env.token)
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(baseLayer, NotionDataSourceGatewayLive.pipe(Layer.provide(baseLayer))),
      ),
    ),
  )
}

const runLiveBody = <A, E>(
  env: { readonly token: string | undefined },
  effect: Effect.Effect<A, E, PageBodySyncPort | NotionMdGateway>,
) => {
  if (env.token === undefined) {
    throw new Error('live NotionMD body test requires a token after configuration validation')
  }

  return Effect.runPromise(
    effect.pipe(
      Effect.provideServiceEffect(
        PageBodySyncPort,
        NotionMdGateway.pipe(Effect.map((gateway) => makeNotionMdPageBodySyncPort({ gateway }))),
      ),
      Effect.provide(NotionMdGatewayLive.pipe(Layer.provide(liveLayer(env.token)))),
    ),
  )
}

const propertyIdByName = (properties: Record<string, unknown>, name: string): string => {
  const property = properties[name]
  if (typeof property === 'object' && property !== null && 'id' in property) {
    const id = property.id
    if (typeof id === 'string') return id
  }

  throw new Error(`live fixture property not found: ${name}`)
}

const propertyOptions = (
  properties: Record<string, unknown>,
  name: string,
  type: 'select' | 'multi_select',
) => {
  const property = properties[name]
  if (typeof property !== 'object' || property === null || !(type in property)) {
    throw new Error(`live fixture ${type} property not found: ${name}`)
  }
  const value = (property as Record<string, unknown>)[type]
  if (
    typeof value !== 'object' ||
    value === null ||
    !('options' in value) ||
    Array.isArray((value as Record<string, unknown>).options) === false
  ) {
    throw new Error(`live fixture ${type} property has no options: ${name}`)
  }
  const options = (value as { readonly options: ReadonlyArray<unknown> }).options

  const toCanonicalOption = (option: unknown) => {
    if (typeof option !== 'object' || option === null || !('name' in option)) {
      throw new Error(`live fixture ${type} option has invalid shape: ${name}`)
    }
    const optionRecord = option as Record<string, unknown>
    const id = typeof optionRecord.id === 'string' ? optionRecord.id : undefined
    const color = typeof optionRecord.color === 'string' ? optionRecord.color : undefined
    return {
      _tag: 'CanonicalOptionValue' as const,
      ...(id === undefined ? {} : { id: decode(PropertyId, id) }),
      name: decode(PropertyName, String(optionRecord.name)),
      ...(color === undefined ? {} : { color }),
    }
  }
  return options.map(toCanonicalOption)
}

const makeLedgerRecorder = (
  env: ReturnType<typeof liveNotionEnvFromProcessEnv>,
  config: Extract<ReturnType<typeof liveNotionConfigFromEnv>, { readonly _tag: 'configured' }>,
  initialLedger: LiveFixtureLedger,
) => {
  let ledger = initialLedger
  const writeLedger = makeLiveFixtureLedgerWriter({ env, config })

  const record = async (
    entry: Parameters<typeof ledgerEntry>[0],
  ): Promise<LiveFixtureLedger> => {
    ledger = { ...ledger, entries: [...ledger.entries, ledgerEntry(entry)] }
    await writeLedger({ path: config.ledgerPath, ledger })
    return ledger
  }

  return {
    current: () => ledger,
    record,
  }
}

const archiveDatabaseBestEffort = (
  env: ReturnType<typeof liveNotionEnvFromProcessEnv>,
  databaseId: string,
) =>
  runLive(
    env,
    NotionDatabases.archive({ databaseId }).pipe(
      Effect.catchAll((cause) =>
        String(cause).toLowerCase().includes('archived') === true
          ? Effect.void
          : Effect.fail(cause),
      ),
    ),
  )

describe('notion datasource sync live Notion E2E skeleton', () => {
  it('has a declared live scenario implementation', () => {
    expect(
      scenarioImplementationGaps({
        file: 'src/e2e/live-notion.e2e.test.ts',
        implementedScenarioIds: implementedLiveScenarioIds,
      }),
    ).toEqual([])
  })

  it('reports an explicit not-configured state when live Notion is not opted in', () => {
    const config = liveNotionConfigFromEnv(
      liveNotionEnvFromProcessEnv({
        NOTION_API_TOKEN: undefined,
        NOTION_TOKEN: undefined,
        NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID: undefined,
        NOTION_DATASOURCE_SYNC_DATA_SOURCE_ID: undefined,
        NOTION_DATASOURCE_SYNC_LEDGER_PATH: undefined,
        NOTION_DATASOURCE_SYNC_LIVE: undefined,
      }),
    )

    expect(config._tag).toBe('not-configured')
    if (config._tag !== 'not-configured') return
    expect(config.skipReason).toContain('live Notion E2E disabled')
    expect(config.missing).toEqual(['NOTION_DATASOURCE_SYNC_LIVE=1'])
  })

  it('fails closed for partial opt-in live Notion configuration', () => {
    const config = liveNotionConfigFromEnv(
      liveNotionEnvFromProcessEnv({
        NOTION_DATASOURCE_SYNC_LIVE: '1',
        NOTION_API_TOKEN: 'ntn_realistic_token_shape',
        NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID: undefined,
        NOTION_DATASOURCE_SYNC_DATA_SOURCE_ID: '00000000000000000000000000000000',
      }),
    )

    expect(config).toMatchObject({
      _tag: 'invalid-config',
      missing: ['NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID'],
      invalid: [],
    })
  })

  it('supports parent-only live Notion configuration for disposable data-source fixtures', () => {
    const config = liveNotionConfigFromEnv(
      liveNotionEnvFromProcessEnv({
        NOTION_DATASOURCE_SYNC_LIVE: '1',
        NOTION_API_TOKEN: 'ntn_realistic_token_shape',
        NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID: '00000000000000000000000000000001',
        NOTION_DATASOURCE_SYNC_DATA_SOURCE_ID: undefined,
      }),
    )

    expect(config).toMatchObject({
      _tag: 'configured',
      parentPageId: '00000000000000000000000000000001',
      dataSourceId: undefined,
    })
  })

  it('supports explicit visible ledger and demo page configuration', () => {
    const config = liveNotionConfigFromEnv(
      liveNotionEnvFromProcessEnv({
        NOTION_DATASOURCE_SYNC_LIVE: '1',
        NOTION_API_TOKEN: 'ntn_realistic_token_shape',
        NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID: '00000000000000000000000000000001',
        NOTION_DATASOURCE_SYNC_E2E_LEDGER_PAGE_ID: '00000000000000000000000000000002',
        NOTION_DATASOURCE_SYNC_DEMO_PAGE_ID: '36cf141b18dc803b98ebd21f2a243453',
      }),
    )

    expect(config).toMatchObject({
      _tag: 'configured',
      e2eLedgerPageId: '00000000000000000000000000000002',
      demoPageId: '36cf141b18dc803b98ebd21f2a243453',
    })
  })

  it('does not opt in when dummy full live Notion env is present without the live flag', () => {
    const config = liveNotionConfigFromEnv(
      liveNotionEnvFromProcessEnv({
        NOTION_API_TOKEN: 'dummy-token',
        NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID: 'parent-page-id',
        NOTION_DATASOURCE_SYNC_DATA_SOURCE_ID: 'data-source-id',
        NOTION_DATASOURCE_SYNC_LEDGER_PATH: 'tmp/notion-datasource-sync-live/dummy.json',
        NOTION_DATASOURCE_SYNC_LIVE: undefined,
      }),
    )

    expect(config).toMatchObject({
      _tag: 'not-configured',
      missing: ['NOTION_DATASOURCE_SYNC_LIVE=1'],
    })
  })

  it('fails closed for opted-in dummy live Notion configuration', () => {
    const config = liveNotionConfigFromEnv(
      liveNotionEnvFromProcessEnv({
        NOTION_DATASOURCE_SYNC_LIVE: '1',
        NOTION_API_TOKEN: 'dummy-token',
        NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID: 'parent-page-id',
        NOTION_DATASOURCE_SYNC_DATA_SOURCE_ID: 'data-source-id',
      }),
    )

    expect(config).toMatchObject({
      _tag: 'invalid-config',
      missing: [],
      invalid: [
        'NOTION_API_TOKEN',
        'NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID',
        'NOTION_DATASOURCE_SYNC_DATA_SOURCE_ID',
      ],
    })
    if (config._tag !== 'invalid-config') return
    expect(config.message).toContain('invalid configuration')
  })

  it('fails closed for invalid explicit ledger and demo page ids', () => {
    const config = liveNotionConfigFromEnv(
      liveNotionEnvFromProcessEnv({
        NOTION_DATASOURCE_SYNC_LIVE: '1',
        NOTION_API_TOKEN: 'ntn_realistic_token_shape',
        NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID: '00000000000000000000000000000001',
        NOTION_DATASOURCE_SYNC_E2E_LEDGER_PAGE_ID: 'not-a-page-id',
        NOTION_DATASOURCE_SYNC_DEMO_PAGE_ID: 'also-not-a-page-id',
      }),
    )

    expect(config).toMatchObject({
      _tag: 'invalid-config',
      invalid: [
        'NOTION_DATASOURCE_SYNC_E2E_LEDGER_PAGE_ID',
        'NOTION_DATASOURCE_SYNC_DEMO_PAGE_ID',
      ],
    })
  })

  it('defaults live preflight to read-only capabilities', () => {
    const config = liveNotionConfigFromEnv(
      liveNotionEnvFromProcessEnv({
        NOTION_DATASOURCE_SYNC_LIVE: '1',
        NOTION_API_TOKEN: 'ntn_realistic_token_shape',
        NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID: '00000000000000000000000000000001',
        NOTION_DATASOURCE_SYNC_DATA_SOURCE_ID: '00000000000000000000000000000002',
      }),
    )

    expect(config).toMatchObject({
      _tag: 'configured',
      requiredCapabilities: [...defaultLivePreflightCapabilities],
    })
  })

  it('runs default live preflight read probes without requiring page-property pagination', async () => {
    const configured = {
      _tag: 'configured' as const,
      runId: 'notion-ds-sync-default-read-preflight-test',
      parentPageId: testIds.pageId,
      dataSourceId: testIds.dataSourceId,
      notionVersion: '2026-03-11' as const,
      requiredCapabilities: defaultLivePreflightCapabilities,
      ledgerPath: 'tmp/notion-datasource-sync-live/default-read-preflight-test.json',
    }
    const calls = {
      queryRows: 0,
      retrievePage: 0,
      retrievePageProperty: 0,
    }
    const ledgers: Array<LiveFixtureLedger> = []
    const harness = makeFakeGatewayHarness({ capabilities: defaultLivePreflightCapabilities })
    const gateway: NotionDataSourceGatewayShape = {
      ...harness.gateway,
      queryRows: (input) => {
        calls.queryRows += 1
        return harness.gateway.queryRows(input)
      },
      retrievePage: (input) => {
        calls.retrievePage += 1
        return harness.gateway.retrievePage(input)
      },
      retrievePageProperty: (input) => {
        calls.retrievePageProperty += 1
        return harness.gateway.retrievePageProperty(input)
      },
    }

    const result = await runLiveNotionPreflight({
      env: {
        enabled: true,
        token: 'ntn_realistic_token_shape',
        tokenSource: 'NOTION_API_TOKEN',
        parentPageId: configured.parentPageId,
        dataSourceId: configured.dataSourceId,
        requiredCapabilities: undefined,
        ledgerPath: configured.ledgerPath,
      },
      config: configured,
      options: {
        gatewayLayer: makeNotionDataSourceGatewayLayer(gateway),
        writeLedger: async ({ ledger }) => {
          ledgers.push(ledger)
        },
      },
    })

    expect(result.missingCapabilities).toEqual([])
    expect(calls).toEqual({ queryRows: 1, retrievePage: 1, retrievePageProperty: 0 })
    expect(ledgers.flatMap((ledger) => ledger.entries)).toEqual(
      expect.arrayContaining([expect.objectContaining({ cleanupState: 'verified-cleaned' })]),
    )
  })

  it('does not run live read probes or write verified-cleaned ledger entries when requested capabilities are missing', async () => {
    const configured = {
      _tag: 'configured' as const,
      runId: 'notion-ds-sync-missing-capability-test',
      parentPageId: '00000000000000000000000000000001',
      dataSourceId: '00000000000000000000000000000002',
      notionVersion: '2026-03-11' as const,
      requiredCapabilities: ['data_source_query', 'page_retrieve'] as const,
      ledgerPath: 'tmp/notion-datasource-sync-live/missing-capability-test.json',
    }
    const calls = {
      queryRows: 0,
      retrievePage: 0,
    }
    const ledgers: Array<LiveFixtureLedger> = []
    const apiContract = makeNotionApiContract({
      supportedCapabilities: ['data_source_query'],
    })
    const gateway: NotionDataSourceGatewayShape = {
      apiContract,
      preflightCapabilities: (input) =>
        Effect.succeed({
          _tag: 'CapabilityPreflightResult',
          dataSourceId: input.dataSourceId,
          apiContract,
          supportedCapabilities: input.requiredCapabilities.filter((capability) =>
            apiContract.supportedCapabilities.includes(capability),
          ),
          missingCapabilities: input.requiredCapabilities.filter(
            (capability) => apiContract.supportedCapabilities.includes(capability) === false,
          ),
        }),
      retrieveDataSource: () => Effect.die('retrieveDataSource should not be called'),
      queryRows: () => {
        calls.queryRows += 1
        return Stream.die('queryRows should not be called')
      },
      retrievePage: () => {
        calls.retrievePage += 1
        return Effect.die('retrievePage should not be called')
      },
      retrievePageProperty: () => Stream.die('retrievePageProperty should not be called'),
      patchPageProperties: () => Effect.die('patchPageProperties should not be called'),
      patchDataSourceSchema: () => Effect.die('patchDataSourceSchema should not be called'),
      trashPage: () => Effect.die('trashPage should not be called'),
      restorePage: () => Effect.die('restorePage should not be called'),
    }

    await expect(
      runLiveNotionPreflight({
        env: {
          enabled: true,
          token: 'ntn_realistic_token_shape',
          tokenSource: 'NOTION_API_TOKEN',
          parentPageId: configured.parentPageId,
          dataSourceId: configured.dataSourceId,
          requiredCapabilities: configured.requiredCapabilities.join(','),
          ledgerPath: configured.ledgerPath,
        },
        config: configured,
        options: {
          gatewayLayer: makeNotionDataSourceGatewayLayer(gateway),
          writeLedger: async ({ ledger }) => {
            ledgers.push(ledger)
          },
        },
      }),
    ).rejects.toThrow('Missing Notion capability: page_retrieve')

    expect(calls).toEqual({ queryRows: 0, retrievePage: 0 })
    expect(ledgers.flatMap((ledger) => ledger.entries)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ cleanupState: 'verified-cleaned' })]),
    )
  })

  it('fails closed before read probes when page-property pagination is required but unsupported', async () => {
    const configured = {
      _tag: 'configured' as const,
      runId: 'notion-ds-sync-page-property-capability-test',
      parentPageId: '00000000000000000000000000000001',
      dataSourceId: '00000000000000000000000000000002',
      notionVersion: '2026-03-11' as const,
      requiredCapabilities: strictLivePreflightCapabilities,
      ledgerPath: 'tmp/notion-datasource-sync-live/page-property-capability-test.json',
    }
    const calls = {
      queryRows: 0,
      retrievePage: 0,
      retrievePageProperty: 0,
    }
    const apiContract = makeNotionApiContract({
      supportedCapabilities: ['data_source_retrieve', 'data_source_query', 'page_retrieve'],
    })
    const gateway: NotionDataSourceGatewayShape = {
      apiContract,
      preflightCapabilities: (input) =>
        Effect.succeed({
          _tag: 'CapabilityPreflightResult',
          dataSourceId: input.dataSourceId,
          apiContract,
          supportedCapabilities: input.requiredCapabilities.filter((capability) =>
            apiContract.supportedCapabilities.includes(capability),
          ),
          missingCapabilities: input.requiredCapabilities.filter(
            (capability) => apiContract.supportedCapabilities.includes(capability) === false,
          ),
        }),
      retrieveDataSource: () => Effect.die('retrieveDataSource should not be called'),
      queryRows: () => {
        calls.queryRows += 1
        return Stream.die('queryRows should not be called')
      },
      retrievePage: () => {
        calls.retrievePage += 1
        return Effect.die('retrievePage should not be called')
      },
      retrievePageProperty: () => {
        calls.retrievePageProperty += 1
        return Stream.die('retrievePageProperty should not be called')
      },
      patchPageProperties: () => Effect.die('patchPageProperties should not be called'),
      patchDataSourceSchema: () => Effect.die('patchDataSourceSchema should not be called'),
      trashPage: () => Effect.die('trashPage should not be called'),
      restorePage: () => Effect.die('restorePage should not be called'),
    }

    await expect(
      runLiveNotionPreflight({
        env: {
          enabled: true,
          token: 'ntn_realistic_token_shape',
          tokenSource: 'NOTION_API_TOKEN',
          parentPageId: configured.parentPageId,
          dataSourceId: configured.dataSourceId,
          requiredCapabilities: configured.requiredCapabilities.join(','),
          ledgerPath: configured.ledgerPath,
        },
        config: configured,
        options: { gatewayLayer: makeNotionDataSourceGatewayLayer(gateway) },
      }),
    ).rejects.toThrow('Missing Notion capability: page_property_paginate')

    expect(calls).toEqual({ queryRows: 0, retrievePage: 0, retrievePageProperty: 0 })
  })

  it('runs strict real-adapter preflight once all required capabilities are supported', async () => {
    const configured = {
      _tag: 'configured' as const,
      runId: 'notion-ds-sync-real-adapter-strict-page-property-test',
      parentPageId: '00000000000000000000000000000001',
      dataSourceId: '00000000000000000000000000000002',
      notionVersion: '2026-03-11' as const,
      requiredCapabilities: strictLivePreflightCapabilities,
      ledgerPath: 'tmp/notion-datasource-sync-live/real-adapter-strict-page-property-test.json',
    }
    const calls = {
      retrieveDataSource: 0,
      queryDataSource: 0,
      retrievePage: 0,
      retrievePageProperty: 0,
      updatePage: 0,
      updateDataSource: 0,
    }
    const ledgers: Array<LiveFixtureLedger> = []
    const client: NotionGatewayClient = {
      retrieveDataSource: ({ dataSourceId }) =>
        Effect.sync(() => {
          calls.retrieveDataSource += 1
          return {
            id: dataSourceId,
            properties: {
              Name: { id: 'title', name: 'Name', type: 'title' },
            },
          }
        }),
      queryDataSource: () => {
        calls.queryDataSource += 1
        return Effect.succeed({ results: [], nextCursor: Option.none(), hasMore: false })
      },
      retrievePage: ({ pageId }) => {
        calls.retrievePage += 1
        return Effect.succeed({
          id: pageId,
          parent: { type: 'data_source_id', data_source_id: configured.dataSourceId },
          properties: {},
          last_edited_time: '2026-05-25T00:00:00.000Z',
          in_trash: false,
        })
      },
      retrievePageProperty: () => {
        calls.retrievePageProperty += 1
        return Effect.succeed({ results: [], nextCursor: Option.none(), hasMore: false })
      },
      updatePage: ({ pageId }) => {
        calls.updatePage += 1
        return Effect.succeed({
          id: pageId,
          parent: { type: 'data_source_id', data_source_id: configured.dataSourceId },
          properties: {},
          last_edited_time: '2026-05-25T00:00:00.000Z',
          in_trash: false,
        })
      },
      updateDataSource: ({ dataSourceId }) => {
        calls.updateDataSource += 1
        return Effect.succeed({
          id: dataSourceId,
          properties: {
            Name: { id: 'title', name: 'Name', type: 'title' },
          },
        })
      },
    }

    const result = await runLiveNotionPreflight({
      env: {
        enabled: true,
        token: 'ntn_realistic_token_shape',
        tokenSource: 'NOTION_API_TOKEN',
        parentPageId: configured.parentPageId,
        dataSourceId: configured.dataSourceId,
        e2eLedgerPageId: undefined,
        demoPageId: undefined,
        requiredCapabilities: configured.requiredCapabilities.join(','),
        ledgerPath: configured.ledgerPath,
      },
      config: configured,
      options: {
        gatewayLayer: makeNotionDataSourceGatewayLayer(
          makeNotionDataSourceGatewayFromClient({ client }),
        ),
        writeLedger: async ({ ledger }) => {
          ledgers.push(ledger)
        },
      },
    })

    expect(calls).toEqual({
      retrieveDataSource: 1,
      queryDataSource: 1,
      retrievePage: 1,
      retrievePageProperty: 0,
      updatePage: 0,
      updateDataSource: 0,
    })
    expect(result.missingCapabilities).toEqual([])
    expect(ledgers).toEqual([result.ledger])
  })

  it('runs a real preflight when live Notion is explicitly configured', async () => {
    if (processLiveConfig._tag === 'not-configured') {
      expect(processLiveConfig.skipReason).toContain('live Notion E2E disabled')
      return
    }
    if (processLiveConfig._tag === 'invalid-config') {
      expect(processLiveConfig.message).toContain('invalid configuration')
      return
    }

    const provisioned = await provisionLiveNotionDataSourceFixture({
      env: liveNotionEnvFromProcessEnv(),
      config: processLiveConfig,
    })

    if (provisioned.config.requiredCapabilities.includes('page_property_paginate') === true) {
      await expect(
        runLiveNotionPreflight({
          env: liveNotionEnvFromProcessEnv(),
          config: provisioned.config,
          options: { initialLedger: provisioned.ledger },
        }),
      ).rejects.toThrow('Missing Notion capability: page_property_paginate')
      await provisioned.cleanup(provisioned.ledger)
      return
    }

    let ledger = provisioned.ledger
    try {
      const result = await runLiveNotionPreflight({
        env: liveNotionEnvFromProcessEnv(),
        config: provisioned.config,
        options: { initialLedger: ledger },
      })
      ledger = result.ledger
      expect(result.supportedCapabilities).toEqual(
        expect.arrayContaining([...provisioned.config.requiredCapabilities]),
      )
      expect(result.missingCapabilities).toEqual([])
      expect(result.ledgerPath).toBe(provisioned.config.ledgerPath)
    } finally {
      await provisioned.cleanup(ledger)
    }
  }, 120_000)

  it('reports why the credentialed live fixture lifecycle is skipped when unavailable', () => {
    if (processLiveConfig._tag === 'configured') {
      expect(processLiveConfig.parentPageId).toBeTruthy()
      return
    }

    const reason =
      processLiveConfig._tag === 'not-configured'
        ? processLiveConfig.skipReason
        : processLiveConfig.message
    expect(reason).toMatch(/live Notion E2E|invalid configuration/)
  })

  describe.skipIf(processLiveConfig._tag !== 'configured')(
    'credentialed live Notion fixture lifecycle',
    () => {
      it('creates, verifies, mutates, restores, and cleans up a disposable fixture', async () => {
        if (processLiveConfig._tag !== 'configured') return

        const env = liveNotionEnvFromProcessEnv()
        const fixtureConfig = { ...processLiveConfig, dataSourceId: undefined }
        const provisioned = await provisionLiveNotionDataSourceFixture({ env, config: fixtureConfig })
        let ledger = provisioned.ledger

        try {
          const preflight = await runLiveNotionPreflight({
            env,
            config: provisioned.config,
            options: { initialLedger: ledger },
          })
          ledger = preflight.ledger
          ledger = await runLiveFixtureLifecycle({
            config: provisioned.config,
            client: makeLiveNotionFixtureLifecycleClient({ env, config: provisioned.config }),
            options: {
              initialLedger: ledger,
              writeLedger: makeLiveFixtureLedgerWriter({ env, config: provisioned.config }),
            },
          })

          expect(ledger.entries).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ objectType: 'database', cleanupState: 'created' }),
              expect.objectContaining({ objectType: 'data_source', cleanupState: 'created' }),
              expect.objectContaining({
                objectType: 'page',
                cleanupState: 'verified-cleaned',
              }),
            ]),
          )
          expect(JSON.stringify(ledger)).not.toContain('NOTION_TOKEN')
          expect(JSON.stringify(ledger)).not.toContain('NOTION_API_TOKEN')
        } finally {
          await provisioned.cleanup(ledger)
        }
      }, 120_000)

      it('applies the safe data-source schema patch subset against live Notion', async () => {
        if (processLiveConfig._tag !== 'configured') return

        const env = liveNotionEnvFromProcessEnv()
        const provisioned = await provisionLiveNotionDataSourceFixture({ env, config: processLiveConfig })
        const recorder = makeLedgerRecorder(env, provisioned.config, provisioned.ledger)

        try {
          await runLiveGateway(
            env,
            Effect.gen(function* () {
              const gateway = yield* NotionDataSourceGateway
              const dataSourceId = decode(DataSourceId, provisioned.config.dataSourceId)
              const initial = yield* gateway.retrieveDataSource(dataSourceId)

              yield* gateway.patchDataSourceSchema({
                _tag: 'PatchDataSourceSchemaCommand',
                commandId: decode(CommandId, `${provisioned.config.runId}:schema:add`),
                dataSourceId,
                baseSchemaHash: initial.schemaHash,
                schemaPatch: {},
                operations: [
                  decode(SchemaPatchOperation, {
                    _tag: 'AddProperty',
                    name: 'Notes',
                    definition: { _tag: 'rich_text' },
                  }),
                  decode(SchemaPatchOperation, {
                    _tag: 'AddProperty',
                    name: 'Stage',
                    definition: {
                      _tag: 'select',
                      options: [{ _tag: 'CanonicalOptionValue', name: 'seed' }],
                    },
                  }),
                  decode(SchemaPatchOperation, {
                    _tag: 'AddProperty',
                    name: 'Labels',
                    definition: {
                      _tag: 'multi_select',
                      options: [{ _tag: 'CanonicalOptionValue', name: 'base' }],
                    },
                  }),
                ],
              })

              const added = yield* NotionDataSources.retrieve({
                dataSourceId: provisioned.config.dataSourceId,
              })
              const notesPropertyId = decode(PropertyId, propertyIdByName(added.properties, 'Notes'))
              const stagePropertyId = decode(PropertyId, propertyIdByName(added.properties, 'Stage'))
              const labelsPropertyId = decode(
                PropertyId,
                propertyIdByName(added.properties, 'Labels'),
              )
              const addedSnapshot = yield* gateway.retrieveDataSource(dataSourceId)

              yield* gateway.patchDataSourceSchema({
                _tag: 'PatchDataSourceSchemaCommand',
                commandId: decode(CommandId, `${provisioned.config.runId}:schema:update`),
                dataSourceId,
                baseSchemaHash: addedSnapshot.schemaHash,
                schemaPatch: {},
                operations: [
                  decode(SchemaPatchOperation, {
                    _tag: 'RenameProperty',
                    propertyId: notesPropertyId,
                    newName: 'Notes Renamed',
                  }),
                  decode(SchemaPatchOperation, {
                    _tag: 'AddSelectOptions',
                    propertyId: stagePropertyId,
                    propertyType: 'select',
                    existingOptions: propertyOptions(added.properties, 'Stage', 'select'),
                    newOptions: [{ _tag: 'CanonicalOptionValue', name: 'added' }],
                  }),
                  decode(SchemaPatchOperation, {
                    _tag: 'AddSelectOptions',
                    propertyId: labelsPropertyId,
                    propertyType: 'multi_select',
                    existingOptions: propertyOptions(added.properties, 'Labels', 'multi_select'),
                    newOptions: [{ _tag: 'CanonicalOptionValue', name: 'extra' }],
                  }),
                ],
              })

              const updated = yield* NotionDataSources.retrieve({
                dataSourceId: provisioned.config.dataSourceId,
              })
              expect(updated.properties['Notes']).toBeUndefined()
              expect(updated.properties['Notes Renamed']).toBeDefined()
              expect(
                propertyOptions(updated.properties, 'Stage', 'select').map((option) => option.name),
              ).toEqual(expect.arrayContaining(['seed', 'added']))
              expect(
                propertyOptions(updated.properties, 'Labels', 'multi_select').map(
                  (option) => option.name,
                ),
              ).toEqual(expect.arrayContaining(['base', 'extra']))

              const finalSnapshot = yield* gateway.retrieveDataSource(dataSourceId)
              yield* Effect.flip(
                gateway.patchDataSourceSchema({
                  _tag: 'PatchDataSourceSchemaCommand',
                  commandId: decode(CommandId, `${provisioned.config.runId}:schema:empty`),
                  dataSourceId,
                  baseSchemaHash: finalSnapshot.schemaHash,
                  schemaPatch: {},
                  operations: [],
                }),
              ).pipe(
                Effect.map((error) =>
                  expect(error.message).toContain(
                    'Schema patch requires at least one supported operation',
                  ),
                ),
              )
            }),
          )

          await recorder.record({
            phase: 'mutate',
            objectId: provisioned.config.dataSourceId,
            objectType: 'data_source',
            purpose: 'live-schema-patch-safe-subset',
            cleanupState: 'mutated',
          })
          await recorder.record({
            phase: 'verify',
            objectId: provisioned.config.dataSourceId,
            objectType: 'data_source',
            purpose: 'live-schema-patch-safe-subset',
            cleanupState: 'verified',
          })
        } finally {
          await provisioned.cleanup(recorder.current())
        }
      }, 180_000)

      it('pushes a NotionMD body through the datasource-sync body adapter against live Notion', async () => {
        if (processLiveConfig._tag !== 'configured') return

        const env = liveNotionEnvFromProcessEnv()
        const recorder = makeLedgerRecorder(
          env,
          processLiveConfig,
          emptyLiveFixtureLedger(processLiveConfig),
        )
        let pageId: string | undefined

        try {
          const page = await runLive(
            env,
            NotionPages.create({
              parent: { type: 'page_id', page_id: processLiveConfig.parentPageId },
              properties: { title: title(`notion ds sync body ${processLiveConfig.runId}`) },
              markdown: '# Datasource Sync Body\n\nInitial body',
            }),
          )
          pageId = page.id
          await recorder.record({
            phase: 'create',
            objectId: pageId,
            objectType: 'page',
            purpose: 'live-notion-md-body-push',
            cleanupState: 'created',
          })

          const nextBody = `# Datasource Sync Body\n\nUpdated body ${processLiveConfig.runId}\n`
          await runLiveBody(
            env,
            Effect.gen(function* () {
              const body = yield* PageBodySyncPort
              const id = decode(PageId, page.id)
              const observed = yield* body.observe({ _tag: 'ObserveBodyInput', pageId: id })
              yield* body.push(
                {
                  _tag: 'BodyPushCommand',
                  commandId: decode(CommandId, `${processLiveConfig.runId}:body:push`),
                  pageId: id,
                  baseBodyPointer: observed,
                  nextBodyHash: sha256Hash(nextBody),
                  localBodyPath: decode(WorkspaceRelativePath, `${page.id}.nmd`),
                  localBodyContent: nextBody,
                },
              )
            }),
          )

          const remote = await runLive(env, NotionPages.getMarkdown({ pageId }))
          expect(remote.markdown).toContain(`Updated body ${processLiveConfig.runId}`)
          await recorder.record({
            phase: 'mutate',
            objectId: pageId,
            objectType: 'page',
            purpose: 'live-notion-md-body-push',
            cleanupState: 'mutated',
          })
          await recorder.record({
            phase: 'verify',
            objectId: pageId,
            objectType: 'page',
            purpose: 'live-notion-md-body-push',
            cleanupState: 'verified',
          })
        } finally {
          if (pageId !== undefined) {
            await runLive(env, NotionPages.archive({ pageId }))
            await recorder.record({
              phase: 'trash',
              objectId: pageId,
              objectType: 'page',
              purpose: 'live-notion-md-body-push',
              cleanupState: 'verified-cleaned',
            })
          }
        }
      }, 120_000)

      it('paginates high-cardinality live page relation properties', async () => {
        if (processLiveConfig._tag !== 'configured') return

        const env = liveNotionEnvFromProcessEnv()
        const recorder = makeLedgerRecorder(
          env,
          processLiveConfig,
          emptyLiveFixtureLedger(processLiveConfig),
        )
        let targetDatabaseId: string | undefined
        let sourceDatabaseId: string | undefined

        try {
          const fixture = await runLive(
            env,
            Effect.gen(function* () {
              const targetDatabase = yield* NotionDatabases.create({
                parent: { type: 'page_id', page_id: processLiveConfig.parentPageId },
                title: [text(`notion ds sync relation target ${processLiveConfig.runId}`)],
                is_inline: true,
                properties: { Name: { title: {} } },
              })
              const targetDataSourceId = targetDatabase.data_sources?.[0]?.id ?? targetDatabase.id
              yield* Effect.sync(() => {
                targetDatabaseId = targetDatabase.id
              })
              const relatedPages = yield* Effect.forEach(
                Array.from({ length: 100 }, (_, index) => index),
                (index) =>
                  NotionPages.create({
                    parent: { type: 'data_source_id', data_source_id: targetDataSourceId },
                    properties: { Name: title(`Related ${index.toString().padStart(3, '0')}`) },
                  }),
                { concurrency: 4 },
              )
              const sourceDatabase = yield* NotionDatabases.create({
                parent: { type: 'page_id', page_id: processLiveConfig.parentPageId },
                title: [text(`notion ds sync relation source ${processLiveConfig.runId}`)],
                is_inline: true,
                properties: { Name: { title: {} } },
              })
              const sourceDataSourceId = sourceDatabase.data_sources?.[0]?.id ?? sourceDatabase.id
              yield* Effect.sync(() => {
                sourceDatabaseId = sourceDatabase.id
              })
              const sourceDataSource = yield* NotionDataSources.update({
                dataSourceId: sourceDataSourceId,
                properties: {
                  Related: {
                    relation: { data_source_id: targetDataSourceId, single_property: {} },
                  },
                },
              })
              const sourcePage = yield* NotionPages.create({
                parent: { type: 'data_source_id', data_source_id: sourceDataSourceId },
                properties: {
                  Name: title('High cardinality relation source'),
                  Related: { relation: relatedPages.map((page) => ({ id: page.id })) },
                },
              })

              return {
                targetDatabase,
                sourceDatabase,
                sourceDataSource,
                sourcePage,
              }
            }),
          )
          await recorder.record({
            phase: 'create',
            objectId: fixture.sourceDatabase.id,
            objectType: 'database',
            purpose: 'live-page-property-pagination-source',
            cleanupState: 'created',
          })
          await recorder.record({
            phase: 'create',
            objectId: fixture.targetDatabase.id,
            objectType: 'database',
            purpose: 'live-page-property-pagination-target',
            cleanupState: 'created',
          })

          const relatedPropertyId = decode(
            PropertyId,
            propertyIdByName(fixture.sourceDataSource.properties, 'Related'),
          )
          if (env.token === undefined) {
            throw new Error('live page-property pagination test requires a token')
          }
          const token = env.token
          const baseClient = makeNotionEffectClientGatewayClient(<A, E>(
            effect: Effect.Effect<A, E, NotionConfig | HttpClient.HttpClient>,
          ) => effect.pipe(Effect.provide(liveLayer(token))))
          const gateway = makeNotionDataSourceGatewayFromClient({
            client: {
              ...baseClient,
              retrievePageProperty: (input) =>
                baseClient.retrievePageProperty({ ...input, pageSize: 50 }),
            },
          })
          const pages = await Effect.runPromise(
            gateway
              .retrievePageProperty({
                _tag: 'RetrievePagePropertyInput',
                pageId: decode(PageId, fixture.sourcePage.id),
                propertyId: relatedPropertyId,
                startCursor: null,
              })
              .pipe(Stream.runCollect, Effect.map((chunk) => Array.from(chunk))),
          )

          expect(pages.length).toBeGreaterThan(1)
          expect(pages.reduce((count, page) => count + page.items.length, 0)).toBe(100)
          expect(pages.at(0)?.hasMore).toBe(true)
          expect(pages.at(-1)?.hasMore).toBe(false)
          await recorder.record({
            phase: 'verify',
            objectId: fixture.sourcePage.id,
            objectType: 'page',
            purpose: 'live-page-property-pagination-relation-items',
            cleanupState: 'verified',
          })
        } finally {
          if (sourceDatabaseId !== undefined) {
            await archiveDatabaseBestEffort(env, sourceDatabaseId)
            await recorder.record({
              phase: 'trash',
              objectId: sourceDatabaseId,
              objectType: 'database',
              purpose: 'live-page-property-pagination-source',
              cleanupState: 'verified-cleaned',
            })
          }
          if (targetDatabaseId !== undefined) {
            await archiveDatabaseBestEffort(env, targetDatabaseId)
            await recorder.record({
              phase: 'trash',
              objectId: targetDatabaseId,
              objectType: 'database',
              purpose: 'live-page-property-pagination-target',
              cleanupState: 'verified-cleaned',
            })
          }
        }
      }, 240_000)

      it('maps canonical query filters and high-watermarks to live mutated rows', async () => {
        if (processLiveConfig._tag !== 'configured') return

        const env = liveNotionEnvFromProcessEnv()
        const provisioned = await provisionLiveNotionDataSourceFixture({ env, config: processLiveConfig })
        const recorder = makeLedgerRecorder(env, provisioned.config, provisioned.ledger)

        try {
          const marker = `live-filter-${provisioned.config.runId}`
          const mutated = await runLive(
            env,
            Effect.gen(function* () {
              yield* NotionDataSources.update({
                dataSourceId: provisioned.config.dataSourceId,
                properties: {
                  Marker: { rich_text: {} },
                },
              })
              const beforeMutation = decode(
                Schema.DateTimeUtc,
                new Date(Date.now() - 60_000).toISOString(),
              )
              const alpha = yield* NotionPages.create({
                parent: { type: 'data_source_id', data_source_id: provisioned.config.dataSourceId },
                properties: {
                  Name: title(`Alpha ${marker}`),
                  Marker: { rich_text: [text(`${marker}-include`)] },
                },
              })
              yield* NotionPages.create({
                parent: { type: 'data_source_id', data_source_id: provisioned.config.dataSourceId },
                properties: {
                  Name: title(`Beta ${marker}`),
                  Marker: { rich_text: [text(`${marker}-exclude`)] },
                },
              })
              const updatedAlpha = yield* NotionPages.update({
                pageId: alpha.id,
                properties: {
                  Marker: { rich_text: [text(`${marker}-include-mutated`)] },
                },
              })
              return { beforeMutation, updatedAlpha }
            }),
          )

          const rows = await runLiveGateway(
            env,
            Effect.gen(function* () {
              const gateway = yield* NotionDataSourceGateway
              return yield* gateway
                .queryRows({
                  _tag: 'QueryRowsInput',
                  dataSourceId: decode(DataSourceId, provisioned.config.dataSourceId),
                  queryContract: {
                    _tag: 'QueryContract',
                    apiVersion: '2026-03-11',
                    filter: {
                      _tag: 'property_value',
                      propertyId: decode(PropertyId, 'Marker'),
                      operator: 'contains',
                      value: { _tag: 'rich_text', plainText: `${marker}-include` },
                    },
                    sorts: [],
                    pageSize: 10,
                    highWatermark: mutated.beforeMutation,
                    membershipScope: 'explicit-filter',
                  },
                  startCursor: null,
                })
                .pipe(Stream.runCollect, Effect.map((chunk) => Array.from(chunk)))
            }),
          )

          const pageIds = rows.flatMap((page) => page.rows.map((row) => row.pageId))
          expect(pageIds).toContain(decode(PageId, mutated.updatedAlpha.id))
          await recorder.record({
            phase: 'verify',
            objectId: mutated.updatedAlpha.id,
            objectType: 'page',
            purpose: 'live-query-filter-high-watermark-mutated-row',
            cleanupState: 'verified',
          })
        } finally {
          await provisioned.cleanup(recorder.current())
        }
      }, 180_000)

      it('runs a bounded live fixture soak with repeated row mutations and cleanup ledger evidence', async () => {
        if (processLiveConfig._tag !== 'configured') return

        const env = liveNotionEnvFromProcessEnv()
        const fixtureConfig = { ...processLiveConfig, dataSourceId: undefined }
        const provisioned = await provisionLiveNotionDataSourceFixture({ env, config: fixtureConfig })
        let ledger = provisioned.ledger

        try {
          ledger = await runLiveFixtureSoak({
            config: provisioned.config,
            client: makeLiveNotionFixtureLifecycleClient({ env, config: provisioned.config }),
            options: {
              scenarioName: 'NDS-LIVE-bounded-fixture-soak',
              cycles: 2,
              initialLedger: ledger,
              writeLedger: makeLiveFixtureLedgerWriter({ env, config: provisioned.config }),
            },
          })

          expect(ledger.entries).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                objectType: 'data_source',
                purpose: 'NDS-LIVE-bounded-fixture-soak:start:2-cycles',
                cleanupState: 'verified',
              }),
              expect.objectContaining({
                objectType: 'data_source',
                purpose: 'NDS-LIVE-bounded-fixture-soak:complete',
                cleanupState: 'verified-cleaned',
              }),
            ]),
          )
          expect(
            ledger.entries.filter(
              (entry) => entry.objectType === 'page' && entry.cleanupState === 'verified-cleaned',
            ).length,
          ).toBeGreaterThanOrEqual(2)
          expect(JSON.stringify(ledger)).not.toContain('NOTION_TOKEN')
          expect(JSON.stringify(ledger)).not.toContain('NOTION_API_TOKEN')
          expect(JSON.stringify(ledger)).not.toContain('op://')
        } finally {
          await provisioned.cleanup(ledger)
        }
      }, 180_000)
    },
  )

  it('records create, mutate, verify, trash, and restore fixture lifecycle phases with an injected client', async () => {
    const configured = {
      _tag: 'configured' as const,
      runId: 'notion-ds-sync-fixture-lifecycle-test',
      parentPageId: '00000000000000000000000000000001',
      dataSourceId: '00000000000000000000000000000002',
      notionVersion: '2026-03-11' as const,
      requiredCapabilities: defaultLivePreflightCapabilities,
      ledgerPath: 'tmp/notion-datasource-sync-live/fixture-lifecycle-test.json',
    }
    const calls: string[] = []
    const ledgers: LiveFixtureLedger[] = []
    const client: LiveFixtureLifecycleClient = {
      create: async () => {
        calls.push('create')
        return {
          objectId: 'fixture-page-1',
          objectType: 'page',
          purpose: 'fixture-lifecycle',
        }
      },
      mutate: async (fixture) => {
        calls.push('mutate')
        return fixture
      },
      verify: async () => {
        calls.push('verify')
      },
      trash: async () => {
        calls.push('trash')
      },
      restore: async () => {
        calls.push('restore')
      },
    }

    const ledger = await runLiveFixtureLifecycle({
      config: configured,
      client,
      options: {
        writeLedger: async ({ ledger: writtenLedger }) => {
          ledgers.push(writtenLedger)
        },
      },
    })

    expect(calls).toEqual(['create', 'mutate', 'verify', 'trash', 'restore', 'trash'])
    expect(ledger.entries.map((entry) => entry.phase)).toEqual([
      'create',
      'mutate',
      'verify',
      'trash',
      'restore',
      'trash',
    ])
    expect(ledger.entries.at(-1)).toMatchObject({ cleanupState: 'verified-cleaned' })
    expect(ledgers.at(-1)).toEqual(ledger)
  })

  it('records bounded soak lifecycle phases with an injected client', async () => {
    const configured = {
      _tag: 'configured' as const,
      runId: 'notion-ds-sync-fixture-soak-test',
      parentPageId: '00000000000000000000000000000001',
      dataSourceId: '00000000000000000000000000000002',
      notionVersion: '2026-03-11' as const,
      requiredCapabilities: defaultLivePreflightCapabilities,
      ledgerPath: 'tmp/notion-datasource-sync-live/fixture-soak-test.json',
    }
    const createdPages: string[] = []
    const ledgers: LiveFixtureLedger[] = []
    const client: LiveFixtureLifecycleClient = {
      create: async () => {
        const objectId = `fixture-page-${(createdPages.length + 1).toString()}`
        createdPages.push(objectId)
        return {
          objectId,
          objectType: 'page',
          purpose: 'fixture-soak',
        }
      },
      mutate: async (fixture) => fixture,
      verify: async () => {},
      trash: async () => {},
      restore: async () => {},
    }

    const ledger = await runLiveFixtureSoak({
      config: configured,
      client,
      options: {
        scenarioName: 'NDS-LIVE-bounded-fixture-soak',
        cycles: 2,
        writeLedger: async ({ ledger: writtenLedger }) => {
          ledgers.push(writtenLedger)
        },
      },
    })

    expect(createdPages).toEqual(['fixture-page-1', 'fixture-page-2'])
    expect(ledger.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          objectType: 'data_source',
          purpose: 'NDS-LIVE-bounded-fixture-soak:start:2-cycles',
          cleanupState: 'verified',
        }),
        expect.objectContaining({
          objectType: 'data_source',
          purpose: 'NDS-LIVE-bounded-fixture-soak:cycle:1',
          cleanupState: 'verified',
        }),
        expect.objectContaining({
          objectType: 'data_source',
          purpose: 'NDS-LIVE-bounded-fixture-soak:cycle:2',
          cleanupState: 'verified',
        }),
        expect.objectContaining({
          objectType: 'data_source',
          purpose: 'NDS-LIVE-bounded-fixture-soak:complete',
          cleanupState: 'verified-cleaned',
        }),
      ]),
    )
    expect(
      ledger.entries.filter(
        (entry) => entry.objectType === 'page' && entry.cleanupState === 'verified-cleaned',
      ),
    ).toHaveLength(2)
    expect(ledgers.at(-1)).toEqual(ledger)
  })

  it('keeps the local JSON ledger artifact when using the default writer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-live-ledger-'))
    const path = join(dir, 'ledger.json')
    const configured = {
      _tag: 'configured' as const,
      runId: 'notion-ds-sync-local-ledger-writer-test',
      parentPageId: '00000000000000000000000000000001',
      dataSourceId: '00000000000000000000000000000002',
      notionVersion: '2026-03-11' as const,
      requiredCapabilities: defaultLivePreflightCapabilities,
      ledgerPath: path,
      e2eLedgerPageId: undefined,
      demoPageId: undefined,
    }
    const ledger = {
      ...emptyLiveFixtureLedger(configured),
      entries: [
        ledgerEntry({
          phase: 'preflight',
          objectId: configured.dataSourceId,
          objectType: 'data_source',
          purpose: 'local-ledger-artifact-test',
          cleanupState: 'verified-cleaned',
        }),
      ],
    }

    try {
      await makeLiveFixtureLedgerWriter({
        env: {
          enabled: true,
          token: 'ntn_realistic_token_shape',
          tokenSource: 'NOTION_API_TOKEN',
          parentPageId: configured.parentPageId,
          dataSourceId: configured.dataSourceId,
          e2eLedgerPageId: undefined,
          demoPageId: undefined,
          requiredCapabilities: undefined,
          ledgerPath: path,
        },
        config: configured,
      })({ path, ledger })

      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(ledger)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('publishes a sanitized visible ledger page when configured', async () => {
    const configured = {
      _tag: 'configured' as const,
      runId: 'notion-ds-sync-visible-ledger-writer-test',
      parentPageId: '00000000000000000000000000000001',
      dataSourceId: '00000000000000000000000000000002',
      notionVersion: '2026-03-11' as const,
      requiredCapabilities: defaultLivePreflightCapabilities,
      ledgerPath: 'tmp/notion-datasource-sync-live/visible-ledger-writer-test.json',
      e2eLedgerPageId: '00000000000000000000000000000003',
      demoPageId: '36cf141b18dc803b98ebd21f2a243453',
    }
    const ledger = {
      ...emptyLiveFixtureLedger(configured),
      entries: [
        ledgerEntry({
          phase: 'trash',
          objectId: '00000000000000000000000000000004',
          objectType: 'page',
          purpose: 'visible-ledger-writer-test',
          cleanupState: 'verified-cleaned',
        }),
      ],
    }
    const localWrites: LiveFixtureLedger[] = []
    const published: Array<{ readonly pageId: string; readonly markdown: string }> = []

    await makeLiveFixtureLedgerWriter({
      env: {
        enabled: true,
        token: 'ntn_super_secret_token_value',
        tokenSource: 'NOTION_API_TOKEN',
        parentPageId: configured.parentPageId,
        dataSourceId: configured.dataSourceId,
        e2eLedgerPageId: configured.e2eLedgerPageId,
        demoPageId: configured.demoPageId,
        requiredCapabilities: undefined,
        ledgerPath: configured.ledgerPath,
      },
      config: configured,
      writeLocalLedger: async ({ ledger: writtenLedger }) => {
        localWrites.push(writtenLedger)
      },
      publishLedger: async (entry) => {
        published.push(entry)
      },
    })({ path: configured.ledgerPath, ledger })

    expect(localWrites).toEqual([ledger])
    expect(published).toHaveLength(1)
    expect(published.at(0)).toMatchObject({ pageId: configured.e2eLedgerPageId })
    expect(published.at(0)?.markdown).toContain('# notion datasource sync e2e run ledger')
    expect(published.at(0)?.markdown).toContain('36cf141b18dc803b98ebd21f2a243453')
    expect(published.at(0)?.markdown).not.toContain('ntn_super_secret_token_value')
    expect(published.at(0)?.markdown).not.toContain('NOTION_API_TOKEN')
  })

  it('cleans up the injected live fixture and records the ledger when verification fails', async () => {
    const configured = {
      _tag: 'configured' as const,
      runId: 'notion-ds-sync-fixture-failure-cleanup-test',
      parentPageId: '00000000000000000000000000000001',
      dataSourceId: '00000000000000000000000000000002',
      notionVersion: '2026-03-11' as const,
      requiredCapabilities: defaultLivePreflightCapabilities,
      ledgerPath: 'tmp/notion-datasource-sync-live/fixture-failure-cleanup-test.json',
    }
    const calls: string[] = []
    const ledgers: LiveFixtureLedger[] = []
    const client: LiveFixtureLifecycleClient = {
      create: async () => {
        calls.push('create')
        return {
          objectId: 'fixture-page-1',
          objectType: 'page',
          purpose: 'fixture-failure-cleanup',
        }
      },
      mutate: async (fixture) => {
        calls.push('mutate')
        return fixture
      },
      verify: async () => {
        calls.push('verify')
        throw new Error('forced fixture verification failure')
      },
      trash: async () => {
        calls.push('trash')
      },
      restore: async () => {
        calls.push('restore')
      },
    }

    await expect(
      runLiveFixtureLifecycle({
        config: configured,
        client,
        options: {
          writeLedger: async ({ ledger: writtenLedger }) => {
            ledgers.push(writtenLedger)
          },
        },
      }),
    ).rejects.toThrow('forced fixture verification failure')

    expect(calls).toEqual(['create', 'mutate', 'verify', 'trash'])
    expect(ledgers.at(-1)?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: 'trash', cleanupState: 'verified-cleaned' }),
      ]),
    )
  })

  it.each([
    { cleanupPhase: 'trash' as const, expectedCalls: ['create', 'mutate', 'verify', 'trash'] },
    {
      cleanupPhase: 'restore' as const,
      expectedCalls: ['create', 'mutate', 'verify', 'trash', 'restore'],
    },
    {
      cleanupPhase: 'final-trash' as const,
      expectedCalls: ['create', 'mutate', 'verify', 'trash', 'restore', 'trash'],
    },
  ])(
    'fails closed and preserves ledger evidence when fixture $cleanupPhase cleanup fails',
    async ({ cleanupPhase, expectedCalls }) => {
      const configured = {
        _tag: 'configured' as const,
        runId: `notion-ds-sync-fixture-${cleanupPhase}-cleanup-failure-test`,
        parentPageId: '00000000000000000000000000000001',
        dataSourceId: '00000000000000000000000000000002',
        notionVersion: '2026-03-11' as const,
        requiredCapabilities: defaultLivePreflightCapabilities,
        ledgerPath: `tmp/notion-datasource-sync-live/fixture-${cleanupPhase}-cleanup-failure-test.json`,
      }
      const calls: string[] = []
      let trashCalls = 0
      const ledgers: LiveFixtureLedger[] = []
      const client: LiveFixtureLifecycleClient = {
        create: async () => {
          calls.push('create')
          return {
            objectId: 'fixture-page-1',
            objectType: 'page',
            purpose: `fixture-${cleanupPhase}-cleanup-failure`,
          }
        },
        mutate: async (fixture) => {
          calls.push('mutate')
          return fixture
        },
        verify: async () => {
          calls.push('verify')
        },
        trash: async () => {
          calls.push('trash')
          trashCalls += 1
          if (cleanupPhase === 'trash' || (cleanupPhase === 'final-trash' && trashCalls === 2)) {
            throw new Error('forced fixture trash cleanup failure')
          }
        },
        restore: async () => {
          calls.push('restore')
          if (cleanupPhase === 'restore') {
            throw new Error('forced fixture restore cleanup failure')
          }
        },
      }

      let failure: unknown
      try {
        await runLiveFixtureLifecycle({
          config: configured,
          client,
          options: {
            writeLedger: async ({ ledger: writtenLedger }) => {
              ledgers.push(writtenLedger)
            },
          },
        })
      } catch (cause) {
        failure = cause
      }

      expect(failure).toBeInstanceOf(LiveFixtureCleanupError)
      const expectedFailurePhase = cleanupPhase === 'final-trash' ? 'trash' : cleanupPhase
      expect(failure).toMatchObject({
        phase: expectedFailurePhase,
        ledger: ledgers.at(-1),
        message: `live fixture cleanup failed during ${expectedFailurePhase}`,
      })
      expect(calls).toEqual(expectedCalls)
      expect(ledgers.at(-1)?.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ phase: 'verify', cleanupState: 'verified' }),
          expect.objectContaining({
            phase: cleanupPhase === 'final-trash' ? 'trash' : cleanupPhase,
            cleanupState: 'cleanup-failed',
          }),
        ]),
      )
      if (cleanupPhase === 'restore' || cleanupPhase === 'final-trash') {
        expect(ledgers.at(-1)?.entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ phase: 'trash', cleanupState: 'trashed' }),
          ]),
        )
      }
    },
  )

  describe.skipIf(processLiveConfig._tag !== 'configured' || processLiveConfig.demoPageId === undefined)(
    'credentialed automated demo showcase',
    () => {
      it('refreshes the visible demo page with a datasource-sync showcase', async () => {
        if (processLiveConfig._tag !== 'configured' || processLiveConfig.demoPageId === undefined) {
          return
        }

        const env = liveNotionEnvFromProcessEnv()
        const result = await runLiveNotionDemoShowcase({ env, config: processLiveConfig })

        expect(result.demoPageId).toBe(processLiveConfig.demoPageId)
        expect(result.rowIds).toHaveLength(6)
        expect(result.observation.pages).toBeGreaterThanOrEqual(4)
        expect(result.observation.rows).toBeGreaterThanOrEqual(9)
        expect(result.observation.materializedBodies).toBe(6)
        expect(result.observation.observedProperties).toBe(6)
        expect(result.observation.incompleteProperties).toBe(0)

        const markdown = await runLive(
          env,
          NotionPages.getMarkdown({ pageId: processLiveConfig.demoPageId }),
        )
        expect(markdown.markdown).toContain('notion datasource sync automated demo')
        expect(markdown.markdown).toContain('Verification summary')
        expect(markdown.markdown).toContain(result.runId)
        expect(markdown.markdown).toContain(result.dataSourceId)
        expect(markdown.markdown).not.toContain(env.token ?? 'token-not-configured')
        expect(markdown.markdown).not.toContain('NOTION_API_TOKEN')
        expect(markdown.markdown).not.toContain('op://')
      }, 180_000)
    },
  )

  it('defines a sanitized cleanup ledger shape without exposing secrets', () => {
    const configured =
      processLiveConfig._tag === 'configured'
        ? processLiveConfig
        : {
            _tag: 'configured' as const,
            runId: 'notion-ds-sync-test-run',
            parentPageId: 'parent-page-id',
            dataSourceId: 'data-source-id',
            notionVersion: '2026-03-11' as const,
            requiredCapabilities: [
              'data_source_retrieve',
              'data_source_query',
              'page_retrieve',
            ] as const,
            ledgerPath: 'tmp/notion-datasource-sync-live/notion-ds-sync-test-run.json',
          }
    const ledger = {
      ...emptyLiveFixtureLedger(configured),
      entries: [
        ledgerEntry({
          phase: 'create',
          objectId: 'page-id-1',
          objectType: 'page',
          purpose: 'capability-preflight-fixture',
        }),
      ],
    }

    expect(ledger).toEqual({
      runId: configured.runId,
      notionVersion: '2026-03-11',
      entries: [
        {
          phase: 'create',
          objectId: 'page-id-1',
          objectType: 'page',
          purpose: 'capability-preflight-fixture',
          cleanupState: 'created',
        },
      ],
    })
    expect(JSON.stringify(ledger)).not.toContain('NOTION_TOKEN')
  })
})
