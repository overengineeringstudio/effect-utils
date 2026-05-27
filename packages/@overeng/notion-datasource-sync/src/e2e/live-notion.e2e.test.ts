import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { FetchHttpClient, type HttpClient } from '@effect/platform'
import { Chunk, Effect, Layer, Option, Redacted, Schema, Stream } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  type NotionConfig,
  NotionConfigLive,
  NotionDataSources,
  NotionDatabases,
  NotionPages,
  NotionViews,
} from '@overeng/notion-effect-client'
import { NotionMdGateway, NotionMdGatewayLive } from '@overeng/notion-md'

import {
  AbsolutePath,
  canonicalHash,
  CommandId,
  DataSourceId,
  defaultReplicaPath,
  Hash,
  LocalWorkspacePort,
  establishFromNotion,
  makeFilesystemLocalWorkspacePort,
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
  PatchDataSourceMetadataCommand,
  parseCliCommand,
  parseCliContext,
  PropertyId,
  PropertyName,
  runCliCommandWithRuntime,
  SchemaPatchOperation,
  type SchemaPropertyObservation,
  SyncRootId,
  WorkspaceRelativePath,
  openNotionSyncStore,
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
  'NDS-LIVE-public-sqlite-cdc-write',
  'NDS-LIVE-notion-view-inventory-read',
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

const runLiveAdoption = <A, E>(
  env: { readonly token: string | undefined },
  effect: Effect.Effect<A, E, NotionDataSourceGateway | PageBodySyncPort | NotionMdGateway>,
) => {
  if (env.token === undefined) {
    throw new Error('live Notion adoption test requires a token after configuration validation')
  }

  const baseLayer = liveLayer(env.token)
  const gatewayLayer = NotionDataSourceGatewayLive.pipe(Layer.provide(baseLayer))
  const notionMdLayer = NotionMdGatewayLive.pipe(Layer.provide(baseLayer))
  const bodyLayer = Layer.effect(
    PageBodySyncPort,
    NotionMdGateway.pipe(Effect.map((gateway) => makeNotionMdPageBodySyncPort({ gateway }))),
  ).pipe(Layer.provide(notionMdLayer))

  return Effect.runPromise(
    effect.pipe(Effect.provide(Layer.mergeAll(baseLayer, gatewayLayer, notionMdLayer, bodyLayer))),
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

const livePropertyPlainText = (property: unknown): string => {
  if (typeof property !== 'object' || property === null) return ''
  const textItems =
    'title' in property
      ? (property as { readonly title?: unknown }).title
      : 'rich_text' in property
        ? (property as { readonly rich_text?: unknown }).rich_text
        : undefined
  if (Array.isArray(textItems) === false) return ''
  return textItems
    .map((item) =>
      typeof item === 'object' &&
      item !== null &&
      'plain_text' in item &&
      typeof item.plain_text === 'string'
        ? item.plain_text
        : '',
    )
    .join('')
}

const liveRichTextPlainText = (items: unknown): string =>
  Array.isArray(items) === true
    ? items
        .map((item) =>
          typeof item === 'object' &&
          item !== null &&
          'plain_text' in item &&
          typeof item.plain_text === 'string'
            ? item.plain_text
            : '',
        )
        .join('')
    : ''

const liveDebugJson = (value: unknown): string =>
  JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === 'bigint' ? entry.toString() : entry,
  )

const liveTitlePropertyName = (properties: Record<string, unknown>): string => {
  const entry = Object.entries(properties).find(([, property]) => {
    if (typeof property !== 'object' || property === null) return false
    return (
      ('type' in property && property.type === 'title') ||
      Object.prototype.hasOwnProperty.call(property, 'title')
    )
  })
  if (entry === undefined) {
    throw new Error('live fixture data source does not expose a title property')
  }
  const [fallbackName, property] = entry
  return typeof property === 'object' &&
    property !== null &&
    'name' in property &&
    typeof property.name === 'string'
    ? property.name
    : fallbackName
}

const makeLedgerRecorder = (
  env: ReturnType<typeof liveNotionEnvFromProcessEnv>,
  config: Extract<ReturnType<typeof liveNotionConfigFromEnv>, { readonly _tag: 'configured' }>,
  initialLedger: LiveFixtureLedger,
) => {
  let ledger = initialLedger
  const writeLedger = makeLiveFixtureLedgerWriter({ env, config })

  const record = async (entry: Parameters<typeof ledgerEntry>[0]): Promise<LiveFixtureLedger> => {
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

const liveSchemaProperty = ({
  properties,
  name,
  type,
}: {
  readonly properties: Record<string, unknown>
  readonly name: string
  readonly type: string
}): SchemaPropertyObservation => {
  const property = properties[name]
  if (typeof property !== 'object' || property === null || !('id' in property)) {
    throw new Error(`live fixture property ${name} has no id`)
  }
  const propertyId = (property as { readonly id: unknown }).id
  if (typeof propertyId !== 'string') {
    throw new Error(`live fixture property ${name} id is not a string`)
  }
  return {
    propertyId: decode(PropertyId, propertyId),
    name,
    type,
    configHash: canonicalHash(property),
    writeClass: 'writable',
  }
}

const runLiveCliCommand = async ({
  argv,
  env,
}: {
  readonly argv: ReadonlyArray<string>
  readonly env: ReturnType<typeof liveNotionEnvFromProcessEnv>
}) => {
  const cliCommand = parseCliCommand(argv)
  const command = parseCliContext({ argv, resolvedCommand: cliCommand })
  if (env.token === undefined) {
    throw new Error('live CLI test requires a token after configuration validation')
  }
  try {
    return await Effect.runPromise(
      runCliCommandWithRuntime({
        command: cliCommand,
        context: command,
        options: {
          env:
            env.tokenSource === 'NOTION_TOKEN'
              ? { NOTION_TOKEN: env.token }
              : { NOTION_API_TOKEN: env.token },
        },
      }),
    )
  } finally {
    command.store.close()
  }
}

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
      invalid: ['NOTION_DATASOURCE_SYNC_E2E_LEDGER_PAGE_ID', 'NOTION_DATASOURCE_SYNC_DEMO_PAGE_ID'],
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
      createPage: () => Effect.die('createPage should not be called'),
      patchDataSourceSchema: () => Effect.die('patchDataSourceSchema should not be called'),
      patchDataSourceMetadata: () => Effect.die('patchDataSourceMetadata should not be called'),
      patchDatabaseMetadata: () => Effect.die('patchDatabaseMetadata should not be called'),
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
      supportedCapabilities: [
        'data_source_retrieve',
        'data_source_query',
        'data_source_metadata_update',
        'page_retrieve',
      ],
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
      createPage: () => Effect.die('createPage should not be called'),
      patchDataSourceSchema: () => Effect.die('patchDataSourceSchema should not be called'),
      patchDataSourceMetadata: () => Effect.die('patchDataSourceMetadata should not be called'),
      patchDatabaseMetadata: () => Effect.die('patchDatabaseMetadata should not be called'),
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
      retrieveDatabase: () =>
        Effect.succeed({
          id: 'database-1',
          title: [],
          description: [],
          icon: null,
        }),
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
      createPage: ({ properties }) =>
        Effect.succeed({
          id: 'created-page-1',
          parent: { type: 'data_source_id', data_source_id: configured.dataSourceId },
          properties,
          last_edited_time: '2026-05-25T00:00:00.000Z',
          in_trash: false,
        }),
      updateDataSource: ({ dataSourceId }) => {
        calls.updateDataSource += 1
        return Effect.succeed({
          id: dataSourceId,
          properties: {
            Name: { id: 'title', name: 'Name', type: 'title' },
          },
        })
      },
      updateDatabase: () =>
        Effect.succeed({
          id: 'database-1',
          title: [],
          description: [],
          icon: null,
        }),
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
        const provisioned = await provisionLiveNotionDataSourceFixture({
          env,
          config: fixtureConfig,
        })
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
        const provisioned = await provisionLiveNotionDataSourceFixture({
          env,
          config: processLiveConfig,
        })
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
              const notesPropertyId = decode(
                PropertyId,
                propertyIdByName(added.properties, 'Notes'),
              )
              const stagePropertyId = decode(
                PropertyId,
                propertyIdByName(added.properties, 'Stage'),
              )
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

      it('patches data-source description metadata against live Notion', async () => {
        if (processLiveConfig._tag !== 'configured') return

        const env = liveNotionEnvFromProcessEnv()
        const provisioned = await provisionLiveNotionDataSourceFixture({
          env,
          config: processLiveConfig,
        })
        const recorder = makeLedgerRecorder(env, provisioned.config, provisioned.ledger)
        const description = `datasource-sync metadata description ${provisioned.config.runId}`

        try {
          await runLiveGateway(
            env,
            Effect.gen(function* () {
              const gateway = yield* NotionDataSourceGateway
              const dataSourceId = decode(DataSourceId, provisioned.config.dataSourceId)
              const initial = yield* gateway.retrieveDataSource(dataSourceId)
              if (initial.metadataHash === undefined) {
                throw new Error('live data-source metadata hash was unavailable')
              }

              yield* gateway.patchDataSourceMetadata(
                decode(PatchDataSourceMetadataCommand, {
                  _tag: 'PatchDataSourceMetadataCommand',
                  commandId: `${provisioned.config.runId}:metadata:description`,
                  dataSourceId,
                  baseMetadataHash: initial.metadataHash,
                  metadataPatch: { descriptionPlainText: description },
                }),
              )

              const updated = yield* NotionDataSources.retrieve({
                dataSourceId: provisioned.config.dataSourceId,
              })
              expect(updated.description.map((part) => part.plain_text).join('')).toBe(description)
              const finalSnapshot = yield* gateway.retrieveDataSource(dataSourceId)
              expect(finalSnapshot.schemaHash).toBe(initial.schemaHash)
              expect(finalSnapshot.metadataHash).not.toBe(initial.metadataHash)
            }),
          )

          await recorder.record({
            phase: 'mutate',
            objectId: provisioned.config.dataSourceId,
            objectType: 'data_source',
            purpose: 'live-metadata-description-patch',
            cleanupState: 'mutated',
          })
          await recorder.record({
            phase: 'verify',
            objectId: provisioned.config.dataSourceId,
            objectType: 'data_source',
            purpose: 'live-metadata-description-patch',
            cleanupState: 'verified',
          })
        } finally {
          await provisioned.cleanup(recorder.current())
        }
      }, 120_000)

      it('establishes an existing live data source into an empty local workspace', async () => {
        if (processLiveConfig._tag !== 'configured') return

        const env = liveNotionEnvFromProcessEnv()
        const provisioned = await provisionLiveNotionDataSourceFixture({
          env,
          config: processLiveConfig,
        })
        const recorder = makeLedgerRecorder(env, provisioned.config, provisioned.ledger)
        const workspaceRoot = decode(
          AbsolutePath,
          await mkdtemp(join(tmpdir(), 'notion-ds-sync-live-adopt-')),
        )
        const rootId = decode(SyncRootId, `live-adopt:${provisioned.config.runId}`)
        const dataSourceId = decode(DataSourceId, provisioned.config.dataSourceId)
        const store = openNotionSyncStore({ path: join(workspaceRoot, 'store.sqlite') })
        const queryContract = {
          _tag: 'QueryContract' as const,
          apiVersion: '2026-03-11' as const,
          filter: null,
          sorts: [],
          pageSize: 25,
          highWatermark: null,
          membershipScope: 'all-data-source-rows' as const,
        }
        const provideWorkspace = <A, E, R>(effect: Effect.Effect<A, E, R | LocalWorkspacePort>) =>
          effect.pipe(
            Effect.provideService(
              LocalWorkspacePort,
              makeFilesystemLocalWorkspacePort({ root: workspaceRoot }),
            ),
          )

        try {
          const dryRun = await runLiveAdoption(
            env,
            provideWorkspace(
              establishFromNotion({
                store,
                rootId,
                dataSourceId,
                workspaceRoot,
                queryContract,
                schemaProperties: [],
                materializeBodies: false,
                dryRun: true,
              }),
            ),
          )
          expect(dryRun.pushed).toBe(false)
          expect(dryRun.pull.appendedEvents).toBe(0)
          expect(store.replay(rootId)).toHaveLength(0)

          const applied = await runLiveAdoption(
            env,
            provideWorkspace(
              establishFromNotion({
                store,
                rootId,
                dataSourceId,
                workspaceRoot,
                queryContract,
                schemaProperties: [],
                materializeBodies: false,
              }),
            ),
          )
          const rerun = await runLiveAdoption(
            env,
            provideWorkspace(
              establishFromNotion({
                store,
                rootId,
                dataSourceId,
                workspaceRoot,
                queryContract,
                schemaProperties: [],
                materializeBodies: false,
              }),
            ),
          )

          expect(applied.pushed).toBe(false)
          expect(applied.pull.appendedEvents).toBeGreaterThan(0)
          expect(rerun.pushed).toBe(false)
          expect(rerun.pull.appendedEvents).toBe(0)
          await recorder.record({
            phase: 'verify',
            objectType: 'data_source',
            objectId: provisioned.config.dataSourceId,
            cleanupState: 'verified',
            purpose: 'live-sync-from-notion-adoption',
          })
        } finally {
          store.close()
          await rm(workspaceRoot, { recursive: true, force: true })
          await provisioned.cleanup(recorder.current())
        }
      }, 180_000)

      it('applies public SQLite CDC cell and row lifecycle changes against live Notion', async () => {
        if (processLiveConfig._tag !== 'configured') return

        const env = liveNotionEnvFromProcessEnv()
        const provisioned = await provisionLiveNotionDataSourceFixture({
          env,
          config: processLiveConfig,
        })
        const recorder = makeLedgerRecorder(env, provisioned.config, provisioned.ledger)
        const workspaceRoot = decode(
          AbsolutePath,
          await mkdtemp(join(tmpdir(), 'notion-ds-sync-live-sqlite-cdc-')),
        )
        let pageId: string | undefined
        let createdPageId: string | undefined

        try {
          const initialDataSource = await runLive(
            env,
            NotionDataSources.retrieve({ dataSourceId: provisioned.config.dataSourceId }),
          )
          const titlePropertyName = liveTitlePropertyName(initialDataSource.properties)
          const cdcPropertyName = 'CDC Note'
          const filePropertyName = 'CDC File'
          const patchedDataSource = await runLive(
            env,
            NotionDataSources.update({
              dataSourceId: provisioned.config.dataSourceId,
              properties: {
                [cdcPropertyName]: { rich_text: {} },
                [filePropertyName]: { files: {} },
              },
            }),
          )
          await recorder.record({
            phase: 'mutate',
            objectId: provisioned.config.dataSourceId,
            objectType: 'data_source',
            purpose: 'live-public-sqlite-cdc-schema-fixture',
            cleanupState: 'mutated',
          })
          const cdcSchemaProperty = liveSchemaProperty({
            properties: patchedDataSource.properties,
            name: cdcPropertyName,
            type: 'rich_text',
          })
          const titleSchemaProperty = liveSchemaProperty({
            properties: patchedDataSource.properties,
            name: titlePropertyName,
            type: 'title',
          })
          const fileSchemaProperty = liveSchemaProperty({
            properties: patchedDataSource.properties,
            name: filePropertyName,
            type: 'files',
          })
          const liveSchemaProperties = [titleSchemaProperty, cdcSchemaProperty, fileSchemaProperty]
          const initialTitle = `sqlite cdc initial ${provisioned.config.runId}`
          const updatedTitle = `sqlite cdc updated ${provisioned.config.runId}`
          const page = await runLive(
            env,
            NotionPages.create({
              parent: {
                type: 'data_source_id',
                data_source_id: provisioned.config.dataSourceId,
              },
              properties: {
                [titlePropertyName]: title(initialTitle),
                [cdcPropertyName]: { rich_text: [text(initialTitle)] },
              },
            }),
          )
          pageId = page.id
          const livePageId = page.id
          await recorder.record({
            phase: 'create',
            objectId: livePageId,
            objectType: 'page',
            purpose: 'live-public-sqlite-cdc-row',
            cleanupState: 'created',
          })

          await runLiveCliCommand({
            env,
            argv: [
              'sync',
              '--from-notion',
              provisioned.config.dataSourceId,
              workspaceRoot,
              '--schema-properties-json',
              JSON.stringify(liveSchemaProperties),
              '--no-materialize-bodies',
            ],
          })

          const replicaPath = defaultReplicaPath(workspaceRoot)
          const syncArgv = [
            'sync',
            workspaceRoot,
            '--schema-properties-json',
            JSON.stringify(liveSchemaProperties),
          ]
          await runLiveCliCommand({ env, argv: syncArgv })
          const projectedDatabaseId = (() => {
            const db = new DatabaseSync(replicaPath, { readOnly: true })
            try {
              const row = db
                .prepare(`SELECT database_id FROM notion_databases WHERE data_source_id = ?`)
                .get(provisioned.config.dataSourceId) as
                | { readonly database_id: string }
                | undefined
              if (row === undefined) {
                throw new Error('live view inventory test did not project database metadata')
              }
              return row.database_id
            } finally {
              db.close()
            }
          })()
          const liveViewsBefore = await runLive(
            env,
            NotionViews.list({
              databaseId: projectedDatabaseId,
              dataSourceId: provisioned.config.dataSourceId,
              pageSize: 100,
            }),
          )
          const projectedViewsBefore = (() => {
            const db = new DatabaseSync(replicaPath, { readOnly: true })
            try {
              return db
                .prepare(
                  `SELECT view_id, view_name, view_type, view_hash
                   FROM notion_views
                   WHERE data_source_id = ?
                   ORDER BY view_id`,
                )
                .all(provisioned.config.dataSourceId)
            } finally {
              db.close()
            }
          })()
          expect(projectedViewsBefore.length).toBe(liveViewsBefore.results.length)
          if (liveViewsBefore.results.length > 0) {
            expect(projectedViewsBefore).toEqual(
              expect.arrayContaining(
                liveViewsBefore.results.map((view) =>
                  expect.objectContaining({
                    view_id: view.id,
                    view_name: view.name ?? '',
                    view_type: view.type ?? 'unknown',
                  }),
                ),
              ),
            )
          }
          await runLiveCliCommand({ env, argv: syncArgv })
          const projectedViewsAfter = (() => {
            const db = new DatabaseSync(replicaPath, { readOnly: true })
            try {
              return db
                .prepare(
                  `SELECT view_id, view_hash
                   FROM notion_views
                   WHERE data_source_id = ?
                   ORDER BY view_id`,
                )
                .all(provisioned.config.dataSourceId)
            } finally {
              db.close()
            }
          })()
          expect(projectedViewsAfter).toEqual(
            projectedViewsBefore.map((view) => ({
              view_id: (view as { readonly view_id: string }).view_id,
              view_hash: (view as { readonly view_hash: string }).view_hash,
            })),
          )
          await recorder.record({
            phase: 'verify',
            objectId: provisioned.config.dataSourceId,
            objectType: 'data_source',
            purpose: 'live-notion-view-inventory-read',
            cleanupState: 'verified',
          })
          const writeCellChange = () => {
            const db = new DatabaseSync(replicaPath)
            try {
              const cell = db
                .prepare(
                  `SELECT property_id, value_text
                   FROM notion_cells
                   WHERE page_id = ? AND property_name = ?`,
                )
                .get(livePageId, cdcPropertyName) as
                | { readonly property_id: string; readonly value_text: string }
                | undefined
              if (cell === undefined) {
                throw new Error('live public SQLite CDC test did not project the CDC cell')
              }
              expect(cell.property_id).toBe(cdcSchemaProperty.propertyId)
              db.prepare(
                `UPDATE notion_cells
                 SET value_json = ?
                 WHERE page_id = ? AND property_id = ?`,
              ).run(
                JSON.stringify({ _tag: 'rich_text', plainText: updatedTitle }),
                livePageId,
                cell.property_id,
              )
              expect(
                db
                  .prepare(
                    `SELECT status, value_json
                     FROM notion_cell_changes
                     WHERE page_id = ? AND property_id = ?`,
                  )
                  .get(livePageId, cell.property_id),
              ).toMatchObject({
                status: 'pending',
                value_json: JSON.stringify({ _tag: 'rich_text', plainText: updatedTitle }),
              })
            } finally {
              db.close()
            }
          }
          writeCellChange()

          await runLiveCliCommand({ env, argv: syncArgv })
          const afterCell = await runLive(env, NotionPages.retrieve({ pageId: livePageId }))
          expect(livePropertyPlainText(afterCell.properties[cdcPropertyName])).toBe(updatedTitle)
          {
            const db = new DatabaseSync(replicaPath, { readOnly: true })
            try {
              const cellStatuses = db
                .prepare(
                  `SELECT status, unsupported_reason
                   FROM notion_cell_changes
                   WHERE page_id = ?
                   ORDER BY created_at`,
                )
                .all(livePageId)
              expect(cellStatuses, `cell CDC statuses: ${JSON.stringify(cellStatuses)}`).toEqual([
                expect.objectContaining({ status: 'applied' }),
              ])
            } finally {
              db.close()
            }
          }
          await runLiveCliCommand({ env, argv: syncArgv })

          const fileExternalUrl = 'https://www.notion.so/images/favicon.ico'
          {
            const db = new DatabaseSync(replicaPath)
            try {
              const fileCell = db
                .prepare(
                  `SELECT base_hash
                   FROM notion_cells
                   WHERE page_id = ? AND property_id = ?`,
                )
                .get(livePageId, fileSchemaProperty.propertyId) as
                | { readonly base_hash: string }
                | undefined
              if (fileCell === undefined) {
                throw new Error('live public SQLite file CDC test did not project files cell')
              }
              db.prepare(
                `INSERT INTO notion_file_assets (
                   asset_id, source_type, name, external_url
                 ) VALUES (?, 'external_url', ?, ?)`,
              ).run(
                `live-file-asset-${provisioned.config.runId}`,
                'live-file.ico',
                fileExternalUrl,
              )
              db.prepare(
                `INSERT INTO notion_file_changes (
                   change_id, asset_id, action, data_source_id, page_id, property_id, base_hash
                 ) VALUES (?, ?, 'attach_external_url', ?, ?, ?, ?)`,
              ).run(
                `live-file-attach-${provisioned.config.runId}`,
                `live-file-asset-${provisioned.config.runId}`,
                provisioned.config.dataSourceId,
                livePageId,
                fileSchemaProperty.propertyId,
                fileCell.base_hash,
              )
            } finally {
              db.close()
            }
          }
          await runLiveCliCommand({ env, argv: syncArgv })
          let fileProperty: unknown
          for (let attempt = 0; attempt < 5; attempt += 1) {
            const afterFileAttach = await runLive(env, NotionPages.retrieve({ pageId: livePageId }))
            fileProperty = afterFileAttach.properties[filePropertyName]
            if (
              typeof fileProperty === 'object' &&
              fileProperty !== null &&
              'files' in fileProperty &&
              Array.isArray((fileProperty as { readonly files?: unknown }).files) === true &&
              (fileProperty as { readonly files: ReadonlyArray<unknown> }).files.length > 0
            ) {
              break
            }
            await new Promise((resolve) => setTimeout(resolve, 1_000))
          }
          if (
            typeof fileProperty !== 'object' ||
            fileProperty === null ||
            !('files' in fileProperty) ||
            Array.isArray((fileProperty as { readonly files?: unknown }).files) === false
          ) {
            throw new Error('live public SQLite file CDC did not return files property')
          }
          const files = (fileProperty as { readonly files: ReadonlyArray<unknown> }).files
          if (files.length === 0) {
            const db = new DatabaseSync(replicaPath, { readOnly: true })
            try {
              const status = db
                .prepare(
                  `SELECT status, unsupported_reason
                   FROM notion_file_changes
                   WHERE change_id = ?`,
                )
                .get(`live-file-attach-${provisioned.config.runId}`)
              throw new Error(
                `live public SQLite file CDC left remote files empty: ${liveDebugJson({
                  status,
                })}`,
              )
            } finally {
              db.close()
            }
          }
          expect(files).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                name: 'live-file.ico',
                type: 'external',
                external: expect.objectContaining({ url: fileExternalUrl }),
              }),
            ]),
          )
          {
            const db = new DatabaseSync(replicaPath, { readOnly: true })
            try {
              expect(
                db
                  .prepare(
                    `SELECT status, unsupported_reason
                     FROM notion_file_changes
                     WHERE change_id = ?`,
                  )
                  .get(`live-file-attach-${provisioned.config.runId}`),
              ).toMatchObject({ status: 'applied', unsupported_reason: null })
            } finally {
              db.close()
            }
          }
          await runLiveCliCommand({ env, argv: syncArgv })

          {
            const db = new DatabaseSync(replicaPath)
            try {
              db.prepare(`UPDATE notion_rows SET in_trash = 1 WHERE page_id = ?`).run(livePageId)
              expect(
                db
                  .prepare(
                    `SELECT kind, status
                     FROM notion_row_changes
                     WHERE page_id = ? AND kind = 'row_archive'`,
                  )
                  .get(livePageId),
              ).toMatchObject({ kind: 'row_archive', status: 'pending' })
            } finally {
              db.close()
            }
          }
          await runLiveCliCommand({ env, argv: syncArgv })
          const archived = await runLive(env, NotionPages.retrieve({ pageId: livePageId }))
          expect(archived.in_trash).toBe(true)
          await recorder.record({
            phase: 'mutate',
            objectId: livePageId,
            objectType: 'page',
            purpose: 'live-public-sqlite-cdc-archive',
            cleanupState: 'trashed',
          })

          {
            const db = new DatabaseSync(replicaPath)
            try {
              const row = db
                .prepare(`SELECT properties_hash FROM notion_rows WHERE page_id = ?`)
                .get(livePageId) as { readonly properties_hash: string } | undefined
              if (row === undefined) {
                throw new Error('live public SQLite CDC test did not retain row projection')
              }
              db.prepare(`UPDATE notion_rows SET in_trash = 0 WHERE page_id = ?`).run(livePageId)
              db.prepare(
                `INSERT INTO notion_row_changes (
                   change_id, kind, data_source_id, page_id, base_hash
                 )
                 SELECT ?, 'row_restore', ?, ?, ?
                 WHERE NOT EXISTS (
                   SELECT 1 FROM notion_row_changes
                   WHERE page_id = ? AND kind = 'row_restore' AND status IN ('pending', 'queued')
                 )`,
              ).run(
                `live-restore-${provisioned.config.runId}`,
                provisioned.config.dataSourceId,
                livePageId,
                row.properties_hash,
                livePageId,
              )
              expect(
                db
                  .prepare(
                    `SELECT kind, status
                     FROM notion_row_changes
                     WHERE page_id = ? AND kind = 'row_restore'`,
                  )
                  .get(livePageId),
              ).toMatchObject({ kind: 'row_restore', status: 'pending' })
            } finally {
              db.close()
            }
          }
          const restoreSync = await runLiveCliCommand({ env, argv: syncArgv })
          const restored = await runLive(env, NotionPages.retrieve({ pageId: livePageId }))
          if (restored.in_trash !== false) {
            const db = new DatabaseSync(replicaPath, { readOnly: true })
            try {
              const rowChanges = db
                .prepare(
                  `SELECT kind, status, unsupported_reason
                   FROM notion_row_changes
                   WHERE page_id = ?
                   ORDER BY created_at`,
                )
                .all(livePageId)
              throw new Error(
                `live public SQLite CDC restore did not update Notion: ${liveDebugJson({
                  rowChanges,
                  restoreSync,
                })}`,
              )
            } finally {
              db.close()
            }
          }
          {
            const db = new DatabaseSync(replicaPath, { readOnly: true })
            try {
              expect(
                db
                  .prepare(
                    `SELECT kind, status
                     FROM notion_row_changes
                     WHERE page_id = ?
                     ORDER BY created_at`,
                  )
                  .all(livePageId),
              ).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({ kind: 'row_archive', status: 'applied' }),
                  expect.objectContaining({ kind: 'row_restore', status: 'applied' }),
                ]),
              )
            } finally {
              db.close()
            }
          }

          const databaseTitle = `sqlite cdc database ${provisioned.config.runId}`
          const databaseDescription = `database description ${provisioned.config.runId}`
          let liveDatabaseId: string | undefined
          {
            const db = new DatabaseSync(replicaPath)
            try {
              const database = db
                .prepare(
                  `SELECT database_id, metadata_hash
                   FROM notion_databases
                   WHERE data_source_id = ?`,
                )
                .get(provisioned.config.dataSourceId) as
                | {
                    readonly database_id: string
                    readonly metadata_hash: string
                  }
                | undefined
              if (database === undefined) {
                throw new Error('live database metadata CDC test did not project the database')
              }
              liveDatabaseId = database.database_id
              db.prepare(
                `INSERT INTO notion_metadata_changes (
                   change_id, data_source_id, database_id, resource_type, title_plain_text,
                   description_plain_text, base_hash
                 ) VALUES (?, ?, ?, 'database', ?, ?, ?)`,
              ).run(
                `live-database-metadata-${provisioned.config.runId}`,
                provisioned.config.dataSourceId,
                database.database_id,
                databaseTitle,
                databaseDescription,
                database.metadata_hash,
              )
            } finally {
              db.close()
            }
          }
          await runLiveCliCommand({ env, argv: syncArgv })
          if (liveDatabaseId === undefined) {
            throw new Error('live database metadata CDC test did not capture database id')
          }
          const databaseAfter = await runLive(
            env,
            NotionDatabases.retrieve({ databaseId: liveDatabaseId }),
          )
          expect(liveRichTextPlainText(databaseAfter.title)).toBe(databaseTitle)
          expect(liveRichTextPlainText(databaseAfter.description)).toBe(databaseDescription)
          {
            const db = new DatabaseSync(replicaPath, { readOnly: true })
            try {
              expect(
                db
                  .prepare(
                    `SELECT status, unsupported_reason
                     FROM notion_metadata_changes
                     WHERE change_id = ?`,
                  )
                  .get(`live-database-metadata-${provisioned.config.runId}`),
              ).toMatchObject({ status: 'applied', unsupported_reason: null })
            } finally {
              db.close()
            }
          }

          const createdTitle = `sqlite cdc created ${provisioned.config.runId}`
          {
            const db = new DatabaseSync(replicaPath)
            try {
              const source = db
                .prepare(`SELECT schema_hash FROM notion_data_sources WHERE data_source_id = ?`)
                .get(provisioned.config.dataSourceId) as { readonly schema_hash: string }
              db.prepare(
                `INSERT INTO notion_row_creates (
                   change_id,
                   data_source_id,
                   local_row_id,
                   client_request_key,
                   initial_values_json,
                   base_schema_hash
                 ) VALUES (?, ?, ?, ?, ?, ?)`,
              ).run(
                `live-create-${provisioned.config.runId}`,
                provisioned.config.dataSourceId,
                `local-${provisioned.config.runId}`,
                `client-${provisioned.config.runId}`,
                JSON.stringify({
                  [titleSchemaProperty.propertyId]: { _tag: 'title', plainText: createdTitle },
                  [cdcSchemaProperty.propertyId]: {
                    _tag: 'rich_text',
                    plainText: `created note ${provisioned.config.runId}`,
                  },
                }),
                source.schema_hash,
              )
              expect(
                db
                  .prepare(
                    `SELECT sync_status
                     FROM notion_rows_effective
                     WHERE local_row_id = ?`,
                  )
                  .get(`local-${provisioned.config.runId}`),
              ).toMatchObject({ sync_status: 'pending' })
            } finally {
              db.close()
            }
          }
          await runLiveCliCommand({ env, argv: syncArgv })
          {
            const db = new DatabaseSync(replicaPath, { readOnly: true })
            try {
              const createRow = db
                .prepare(
                  `SELECT status, remote_page_id, unsupported_reason
                   FROM notion_row_creates
                   WHERE change_id = ?`,
                )
                .get(`live-create-${provisioned.config.runId}`) as
                | {
                    readonly status: string
                    readonly remote_page_id: string | null
                    readonly unsupported_reason: string | null
                  }
                | undefined
              expect(createRow).toMatchObject({ status: 'applied', unsupported_reason: null })
              if (createRow?.remote_page_id === null || createRow?.remote_page_id === undefined) {
                throw new Error('live public SQLite row create did not persist remote_page_id')
              }
              createdPageId = createRow.remote_page_id
            } finally {
              db.close()
            }
          }
          await recorder.record({
            phase: 'create',
            objectId: createdPageId,
            objectType: 'page',
            purpose: 'live-public-sqlite-cdc-row-create',
            cleanupState: 'created',
          })
          const created = await runLive(env, NotionPages.retrieve({ pageId: createdPageId }))
          expect(livePropertyPlainText(created.properties[titlePropertyName])).toBe(createdTitle)
          await runLiveCliCommand({ env, argv: syncArgv })
          const createdRows = await runLive(
            env,
            NotionDatabases.query({
              dataSourceId: provisioned.config.dataSourceId,
              filter: {
                property: titlePropertyName,
                title: { equals: createdTitle },
              },
            }),
          )
          expect(createdRows.results).toHaveLength(1)

          await recorder.record({
            phase: 'verify',
            objectId: livePageId,
            objectType: 'page',
            purpose: 'live-public-sqlite-cdc-write',
            cleanupState: 'verified',
          })
        } finally {
          if (createdPageId !== undefined) {
            await runLive(
              env,
              NotionPages.update({ pageId: createdPageId, in_trash: true }).pipe(Effect.ignore),
            )
            await recorder.record({
              phase: 'trash',
              objectId: createdPageId,
              objectType: 'page',
              purpose: 'live-public-sqlite-cdc-row-create',
              cleanupState: 'verified-cleaned',
            })
          }
          if (pageId !== undefined) {
            await runLive(env, NotionPages.update({ pageId, in_trash: true }).pipe(Effect.ignore))
            await recorder.record({
              phase: 'trash',
              objectId: pageId,
              objectType: 'page',
              purpose: 'live-public-sqlite-cdc-row',
              cleanupState: 'verified-cleaned',
            })
          }
          await rm(workspaceRoot, { recursive: true, force: true })
          await provisioned.cleanup(recorder.current())
        }
      }, 240_000)

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
              yield* body.push({
                _tag: 'BodyPushCommand',
                commandId: decode(CommandId, `${processLiveConfig.runId}:body:push`),
                pageId: id,
                baseBodyPointer: observed,
                nextBodyHash: sha256Hash(nextBody),
                localBodyPath: decode(WorkspaceRelativePath, `${page.id}.nmd`),
                localBodyContent: nextBody,
              })
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
          const baseClient = makeNotionEffectClientGatewayClient(
            <A, E>(effect: Effect.Effect<A, E, NotionConfig | HttpClient.HttpClient>) =>
              effect.pipe(Effect.provide(liveLayer(token))),
          )
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
              .pipe(
                Stream.runCollect,
                Effect.map((chunk) => Array.from(chunk)),
              ),
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
        const provisioned = await provisionLiveNotionDataSourceFixture({
          env,
          config: processLiveConfig,
        })
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
                .pipe(
                  Stream.runCollect,
                  Effect.map((chunk) => Array.from(chunk)),
                )
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
        const provisioned = await provisionLiveNotionDataSourceFixture({
          env,
          config: fixtureConfig,
        })
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

  describe.skipIf(
    processLiveConfig._tag !== 'configured' || processLiveConfig.demoPageId === undefined,
  )('credentialed automated demo showcase', () => {
    it('refreshes the visible demo page with a datasource-sync showcase', async () => {
      if (processLiveConfig._tag !== 'configured' || processLiveConfig.demoPageId === undefined) {
        return
      }

      const env = liveNotionEnvFromProcessEnv()
      const result = await runLiveNotionDemoShowcase({ env, config: processLiveConfig })

      expect(result.demoPageId).toBe(processLiveConfig.demoPageId)
      expect(result.dataSources.map((dataSource) => dataSource.key)).toEqual([
        'projects',
        'incidents',
        'customers',
        'activity',
      ])
      expect(result.dataSources.map((dataSource) => dataSource.rowIds.length)).toEqual([
        12, 30, 48, 500,
      ])
      expect(
        result.dataSources.find((dataSource) => dataSource.key === 'activity')?.observation.pages,
      ).toBeGreaterThanOrEqual(10)
      expect(result.observation.pages).toBeGreaterThanOrEqual(20)
      expect(result.observation.rows).toBeGreaterThanOrEqual(700)
      expect(result.observation.materializedBodies).toBe(12)
      expect(result.observation.observedProperties).toBe(90)
      expect(result.observation.incompleteProperties).toBe(0)

      const markdown = await runLive(
        env,
        NotionPages.getMarkdown({ pageId: processLiveConfig.demoPageId }),
      )
      expect(markdown.markdown).toContain('notion datasource sync automated demo')
      expect(markdown.markdown).toContain('Verification summary')
      expect(markdown.markdown).toContain('Data source matrix')
      expect(markdown.markdown).toContain('notion datasource sync demo projects')
      expect(markdown.markdown).toContain('notion datasource sync demo incidents')
      expect(markdown.markdown).toContain('notion datasource sync demo customers')
      expect(markdown.markdown).toContain('notion datasource sync demo activity events')
      expect(markdown.markdown).toContain('500 rows')
      expect(markdown.markdown).toContain('Metadata proof')
      expect(markdown.markdown).toContain(result.runId)
      for (const dataSource of result.dataSources) {
        expect(markdown.markdown).toContain(dataSource.dataSourceId)
        expect(markdown.markdown).toContain(dataSource.description)
      }
      expect(markdown.markdown).not.toContain(env.token ?? 'token-not-configured')
      expect(markdown.markdown).not.toContain('NOTION_API_TOKEN')
      expect(markdown.markdown).not.toContain('op://')

      const remoteCounts = await Promise.all(
        result.dataSources.map(async (dataSource) => {
          const remote = await runLive(
            env,
            NotionDataSources.retrieve({ dataSourceId: dataSource.dataSourceId }),
          )
          const rowCount = await runLive(
            env,
            NotionDatabases.queryStream({
              dataSourceId: dataSource.dataSourceId,
              pageSize: 100,
            }).pipe(Stream.runCollect, Effect.map(Chunk.size)),
          )
          return {
            title: remote.title?.map((part) => part.plain_text ?? '').join('') ?? '',
            description: remote.description?.map((part) => part.plain_text ?? '').join('') ?? '',
            propertyNames: Object.keys(remote.properties),
            rowCount,
          }
        }),
      )
      expect(remoteCounts.map((remote) => remote.rowCount)).toEqual([12, 30, 48, 500])
      expect(remoteCounts.map((remote) => remote.title)).toEqual([
        'notion datasource sync demo projects',
        'notion datasource sync demo incidents',
        'notion datasource sync demo customers',
        'notion datasource sync demo activity events',
      ])
      expect(remoteCounts.map((remote) => remote.description)).toEqual(
        result.dataSources.map((dataSource) => dataSource.description),
      )
      expect(remoteCounts[0]?.propertyNames).toEqual(
        expect.arrayContaining([
          'Name',
          'State',
          'Budget',
          'Strategic',
          'Kickoff',
          'Teams',
          'Summary',
          'Brief',
        ]),
      )
      expect(remoteCounts[1]?.propertyNames).toEqual(
        expect.arrayContaining([
          'Name',
          'Severity',
          'Open',
          'Started',
          'Impact',
          'Systems',
          'Notes',
        ]),
      )
      expect(remoteCounts[2]?.propertyNames).toEqual(
        expect.arrayContaining([
          'Name',
          'Plan',
          'ARR',
          'Renewal',
          'Contacted',
          'Regions',
          'Health',
          'Email',
          'Phone',
        ]),
      )
      expect(remoteCounts[3]?.propertyNames).toEqual(
        expect.arrayContaining([
          'Name',
          'Segment',
          'Sequence',
          'Automated',
          'EventDate',
          'Labels',
          'Payload',
        ]),
      )
    }, 1_200_000)
  })

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
