import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { FetchHttpClient, type HttpClient } from '@effect/platform'
import { Effect, Layer, Redacted, Stream } from 'effect'

import {
  type NotionConfig,
  NotionConfigLive,
  NotionDataSources,
  NotionDatabases,
  NotionPages,
} from '@overeng/notion-effect-client'

import { DataSourceId, PageId, type CapabilityName } from '../core/domain.ts'
import { guardCapabilities } from '../core/guards.ts'
import { NotionDataSourceGateway } from '../core/ports.ts'
import { readOnlyGatewayCapabilities } from '../gateway/gateway.ts'
import { NotionDataSourceGatewayLive } from '../gateway/notion.ts'

export type LiveNotionEnv = {
  readonly enabled: boolean
  readonly token: string | undefined
  readonly tokenSource: 'NOTION_API_TOKEN' | 'NOTION_TOKEN' | undefined
  readonly parentPageId: string | undefined
  readonly dataSourceId: string | undefined
  readonly requiredCapabilities: string | undefined
  readonly ledgerPath: string | undefined
}

export type LiveNotionConfig =
  | {
      readonly _tag: 'not-configured'
      readonly skipReason: string
      readonly missing: ReadonlyArray<string>
    }
  | {
      readonly _tag: 'invalid-config'
      readonly message: string
      readonly missing: ReadonlyArray<string>
      readonly invalid: ReadonlyArray<string>
    }
  | {
      readonly _tag: 'configured'
      readonly runId: string
      readonly parentPageId: string
      readonly dataSourceId: string | undefined
      readonly notionVersion: '2026-03-11'
      readonly requiredCapabilities: ReadonlyArray<CapabilityName>
      readonly ledgerPath: string
    }

export type ConfiguredLiveNotionConfig = Extract<LiveNotionConfig, { readonly _tag: 'configured' }>

export type LiveNotionConfigWithDataSource = ConfiguredLiveNotionConfig & {
  readonly dataSourceId: string
}

export type LiveFixtureLedgerEntry = {
  readonly phase: 'preflight' | 'create' | 'mutate' | 'verify' | 'trash' | 'restore'
  readonly objectId: string
  readonly objectType: 'page' | 'data_source' | 'database' | 'block' | 'file'
  readonly purpose: string
  readonly cleanupState:
    | 'created'
    | 'mutated'
    | 'verified'
    | 'trashed'
    | 'restored'
    | 'verified-cleaned'
    | 'cleanup-failed'
}

export type LiveFixtureLedger = {
  readonly runId: string
  readonly notionVersion: '2026-03-11'
  readonly entries: ReadonlyArray<LiveFixtureLedgerEntry>
}

export type LiveNotionPreflightResult = {
  readonly runId: string
  readonly dataSourceId: string
  readonly parentPageId: string
  readonly supportedCapabilities: ReadonlyArray<CapabilityName>
  readonly missingCapabilities: ReadonlyArray<CapabilityName>
  readonly ledgerPath: string
  readonly ledger: LiveFixtureLedger
}

export type LiveNotionPreflightOptions = {
  readonly gatewayLayer?: Layer.Layer<NotionDataSourceGateway>
  readonly writeLedger?: typeof writeLiveFixtureLedger
  readonly initialLedger?: LiveFixtureLedger
}

export type LiveFixtureObject = {
  readonly objectId: string
  readonly objectType: LiveFixtureLedgerEntry['objectType']
  readonly purpose: string
}

export type LiveFixtureLifecycleClient = {
  readonly create: (input: {
    readonly runId: string
    readonly parentPageId: string
    readonly dataSourceId: string
  }) => Promise<LiveFixtureObject>
  readonly mutate: (fixture: LiveFixtureObject) => Promise<LiveFixtureObject>
  readonly verify: (fixture: LiveFixtureObject) => Promise<void>
  readonly trash: (fixture: LiveFixtureObject) => Promise<void>
  readonly restore: (fixture: LiveFixtureObject) => Promise<void>
}

export type LiveFixtureLifecycleOptions = {
  readonly writeLedger?: typeof writeLiveFixtureLedger
  readonly initialLedger?: LiveFixtureLedger
}

export class LiveFixtureCleanupError extends Error {
  readonly phase: 'trash' | 'restore'
  readonly ledger: LiveFixtureLedger

  constructor(input: {
    readonly phase: 'trash' | 'restore'
    readonly cause: unknown
    readonly ledger: LiveFixtureLedger
  }) {
    super(`live fixture cleanup failed during ${input.phase}`, { cause: input.cause })
    this.name = 'LiveFixtureCleanupError'
    this.phase = input.phase
    this.ledger = input.ledger
  }
}

export const defaultLivePreflightCapabilities =
  readOnlyGatewayCapabilities satisfies ReadonlyArray<CapabilityName>

export const strictLivePreflightCapabilities = [
  'data_source_retrieve',
  'data_source_query',
  'page_retrieve',
  'page_property_paginate',
] as const satisfies ReadonlyArray<CapabilityName>

const capabilityNames = new Set<CapabilityName>([
  'data_source_retrieve',
  'data_source_query',
  'page_retrieve',
  'page_property_paginate',
  'page_property_update',
  'schema_update',
  'page_trash',
  'page_restore',
])

export const liveNotionEnvFromProcessEnv = (
  env: NodeJS.ProcessEnv = process.env,
): LiveNotionEnv => {
  const token =
    env.NOTION_API_TOKEN !== undefined && env.NOTION_API_TOKEN.length > 0
      ? env.NOTION_API_TOKEN
      : env.NOTION_TOKEN

  return {
    enabled: env.NOTION_DATASOURCE_SYNC_LIVE === '1',
    token,
    tokenSource:
      env.NOTION_API_TOKEN !== undefined && env.NOTION_API_TOKEN.length > 0
        ? 'NOTION_API_TOKEN'
        : env.NOTION_TOKEN === undefined
          ? undefined
          : 'NOTION_TOKEN',
    parentPageId: env.NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID,
    dataSourceId: env.NOTION_DATASOURCE_SYNC_DATA_SOURCE_ID,
    requiredCapabilities: env.NOTION_DATASOURCE_SYNC_REQUIRED_CAPABILITIES,
    ledgerPath: env.NOTION_DATASOURCE_SYNC_LEDGER_PATH,
  }
}

const looksLikeDummySecret = (value: string): boolean => {
  const normalized = value.trim().toLowerCase()
  return (
    normalized.length === 0 ||
    normalized === 'dummy' ||
    normalized === 'fake' ||
    normalized === 'placeholder' ||
    normalized.includes('dummy') ||
    normalized.includes('fake') ||
    normalized.includes('placeholder') ||
    normalized.includes('test-token')
  )
}

const looksLikeNotionPageId = (value: string): boolean =>
  /^[0-9a-f]{32}$/i.test(value.replaceAll('-', ''))

const parseRequiredCapabilities = (
  value: string | undefined,
): {
  readonly capabilities: ReadonlyArray<CapabilityName>
  readonly invalid: ReadonlyArray<string>
} => {
  if (value === undefined || value.trim().length === 0) {
    return { capabilities: defaultLivePreflightCapabilities, invalid: [] }
  }

  const parsed = value
    .split(',')
    .map((capability) => capability.trim())
    .filter((capability) => capability.length > 0)

  const invalid = parsed.filter(
    (capability): capability is string =>
      capabilityNames.has(capability as CapabilityName) === false,
  )

  return {
    capabilities: parsed.filter((capability): capability is CapabilityName =>
      capabilityNames.has(capability as CapabilityName),
    ),
    invalid,
  }
}

export const liveNotionConfigFromEnv = (env: LiveNotionEnv): LiveNotionConfig => {
  const parentPageId = env.parentPageId
  const dataSourceId = env.dataSourceId
  const token = env.token
  const parsedCapabilities = parseRequiredCapabilities(env.requiredCapabilities)

  if (env.enabled === false) {
    return {
      _tag: 'not-configured',
      skipReason: 'live Notion E2E disabled; set NOTION_DATASOURCE_SYNC_LIVE=1 to opt in',
      missing: ['NOTION_DATASOURCE_SYNC_LIVE=1'],
    }
  }

  const missing = [
    ...(token === undefined ? ['NOTION_API_TOKEN or NOTION_TOKEN'] : []),
    ...(parentPageId === undefined ? ['NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID'] : []),
  ]
  const invalid = [
    ...(token !== undefined && looksLikeDummySecret(token)
      ? [env.tokenSource ?? 'NOTION_API_TOKEN or NOTION_TOKEN']
      : []),
    ...(parentPageId !== undefined && looksLikeNotionPageId(parentPageId) === false
      ? ['NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID']
      : []),
    ...(dataSourceId !== undefined && looksLikeNotionPageId(dataSourceId) === false
      ? ['NOTION_DATASOURCE_SYNC_DATA_SOURCE_ID']
      : []),
    ...parsedCapabilities.invalid.map(
      (capability) => `NOTION_DATASOURCE_SYNC_REQUIRED_CAPABILITIES:${capability}`,
    ),
  ]

  if (
    missing.length > 0 ||
    invalid.length > 0 ||
    token === undefined ||
    parentPageId === undefined
  ) {
    return {
      _tag: 'invalid-config',
      message: `live Notion E2E opted in with invalid configuration; missing ${missing.join(
        ', ',
      )}; invalid ${invalid.join(', ')}`,
      missing,
      invalid,
    }
  }

  return {
    _tag: 'configured',
    runId: `notion-ds-sync-${randomUUID()}`,
    parentPageId,
    dataSourceId,
    notionVersion: '2026-03-11',
    requiredCapabilities: parsedCapabilities.capabilities,
    ledgerPath: env.ledgerPath ?? `tmp/notion-datasource-sync-live/${randomUUID()}.json`,
  }
}

export const emptyLiveFixtureLedger = (config: ConfiguredLiveNotionConfig): LiveFixtureLedger =>
  ({
    runId: config.runId,
    notionVersion: config.notionVersion,
    entries: [],
  }) satisfies LiveFixtureLedger

export const ledgerEntry = (
  input: Omit<LiveFixtureLedgerEntry, 'cleanupState'> & {
    readonly cleanupState?: LiveFixtureLedgerEntry['cleanupState']
  },
): LiveFixtureLedgerEntry => ({
  cleanupState: 'created',
  ...input,
})

const appendLedgerEntry = (
  ledger: LiveFixtureLedger,
  entry: LiveFixtureLedgerEntry,
): LiveFixtureLedger => ({
  ...ledger,
  entries: [...ledger.entries, entry],
})

export const writeLiveFixtureLedger = async (input: {
  readonly path: string
  readonly ledger: LiveFixtureLedger
}): Promise<void> => {
  await mkdir(dirname(input.path), { recursive: true })
  await writeFile(input.path, `${JSON.stringify(input.ledger, null, 2)}\n`, 'utf8')
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const text = (content: string) => ({ type: 'text', text: { content } })

const title = (content: string) => ({ title: [text(content)] })

const mutatedTitle = (fixture: LiveFixtureObject) =>
  `notion datasource sync live fixture mutated ${fixture.objectId}`

const propertyPlainText = (property: unknown): string => {
  if (isRecord(property) === false) return ''
  const titleValue = property.title
  if (Array.isArray(titleValue) === false) return ''

  return titleValue
    .map((item) => (isRecord(item) === true && typeof item.plain_text === 'string' ? item.plain_text : ''))
    .join('')
}

const resolveTitlePropertyName = (properties: Record<string, unknown>): string => {
  const titleEntry = Object.entries(properties).find(([, property]) => {
    if (isRecord(property) === false) return false
    return property.type === 'title' || 'title' in property
  })

  if (titleEntry === undefined) {
    throw new Error('live Notion fixture data source does not expose a title property')
  }

  const [fallbackName, property] = titleEntry
  return isRecord(property) === true && typeof property.name === 'string' ? property.name : fallbackName
}

const makeNotionLiveLayer = (token: string) =>
  Layer.mergeAll(
    NotionConfigLive({
      authToken: Redacted.make(token),
      retryEnabled: true,
      maxRetries: 2,
      retryBaseDelay: 500,
    }),
    FetchHttpClient.layer,
  )

export const makeLiveNotionFixtureLifecycleClient = (
  env: LiveNotionEnv,
  config: LiveNotionConfigWithDataSource,
): LiveFixtureLifecycleClient => {
  if (env.token === undefined) {
    throw new Error('live Notion fixture lifecycle requires a token after configuration validation')
  }

  const layer = makeNotionLiveLayer(env.token)
  const run = <A, E>(effect: Effect.Effect<A, E, NotionConfig | HttpClient.HttpClient>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)))

  const titlePropertyName = Effect.gen(function* () {
    const dataSource = yield* NotionDataSources.retrieve({
      dataSourceId: config.dataSourceId,
    })
    return resolveTitlePropertyName(dataSource.properties)
  })

  const retrievePage = (pageId: string) => NotionPages.retrieve({ pageId })

  const verifyPageState = (input: {
    readonly pageId: string
    readonly expectedTitle: string
    readonly expectedInTrash: boolean
  }) =>
    Effect.gen(function* () {
      const page = yield* retrievePage(input.pageId)
      const titleName = yield* titlePropertyName
      const actualTitle = propertyPlainText(page.properties[titleName])

      if (page.in_trash !== input.expectedInTrash) {
        throw new Error(
          `live Notion fixture ${input.pageId} expected in_trash=${input.expectedInTrash.toString()}`,
        )
      }

      if (actualTitle !== input.expectedTitle) {
        throw new Error(`live Notion fixture ${input.pageId} title verification failed`)
      }
    })

  return {
    create: ({ runId, dataSourceId }) =>
      run(
        Effect.gen(function* () {
          const titleName = yield* titlePropertyName
          const page = yield* NotionPages.create({
            parent: { type: 'data_source_id', data_source_id: dataSourceId },
            properties: {
              [titleName]: title(`notion datasource sync live fixture ${runId}`),
            },
          })

          return {
            objectId: page.id,
            objectType: 'page',
            purpose: 'live-notion-row-fixture',
          } satisfies LiveFixtureObject
        }),
      ),
    mutate: (fixture) =>
      run(
        Effect.gen(function* () {
          const titleName = yield* titlePropertyName
          yield* NotionPages.update({
            pageId: fixture.objectId,
            properties: {
              [titleName]: title(mutatedTitle(fixture)),
            },
          })
          return fixture
        }),
      ),
    verify: (fixture) =>
      run(
        verifyPageState({
          pageId: fixture.objectId,
          expectedTitle: mutatedTitle(fixture),
          expectedInTrash: false,
        }),
      ),
    trash: (fixture) =>
      run(
        Effect.gen(function* () {
          yield* NotionPages.update({ pageId: fixture.objectId, in_trash: true })
          const page = yield* retrievePage(fixture.objectId)
          if (page.in_trash !== true) {
            throw new Error(`live Notion fixture ${fixture.objectId} trash verification failed`)
          }
        }),
      ),
    restore: (fixture) =>
      run(
        Effect.gen(function* () {
          yield* NotionPages.update({ pageId: fixture.objectId, in_trash: false })
          yield* verifyPageState({
            pageId: fixture.objectId,
            expectedTitle: mutatedTitle(fixture),
            expectedInTrash: false,
          })
        }),
      ),
  }
}

export type LiveNotionDataSourceFixture = {
  readonly config: LiveNotionConfigWithDataSource
  readonly ledger: LiveFixtureLedger
  readonly cleanup: (ledger: LiveFixtureLedger) => Promise<LiveFixtureLedger>
}

export const provisionLiveNotionDataSourceFixture = async (
  env: LiveNotionEnv,
  config: ConfiguredLiveNotionConfig,
  options: LiveFixtureLifecycleOptions = {},
): Promise<LiveNotionDataSourceFixture> => {
  if (env.token === undefined) {
    throw new Error(
      'live Notion data source fixture requires a token after configuration validation',
    )
  }

  if (config.dataSourceId !== undefined) {
    return {
      config: { ...config, dataSourceId: config.dataSourceId },
      ledger: options.initialLedger ?? emptyLiveFixtureLedger(config),
      cleanup: async (ledger) => ledger,
    }
  }

  const writeLedger = options.writeLedger ?? writeLiveFixtureLedger
  const layer = makeNotionLiveLayer(env.token)
  let ledger = options.initialLedger ?? emptyLiveFixtureLedger(config)

  const persist = async () => {
    await writeLedger({ path: config.ledgerPath, ledger })
  }

  const record = async (entry: LiveFixtureLedgerEntry) => {
    ledger = appendLedgerEntry(ledger, entry)
    await persist()
  }

  const database = await Effect.runPromise(
    NotionDatabases.create({
      parent: { type: 'page_id', page_id: config.parentPageId },
      title: [text(`notion datasource sync live data source ${config.runId}`)],
      is_inline: true,
      properties: {
        Name: { title: {} },
        Done: { checkbox: {} },
      },
    }).pipe(Effect.provide(layer)),
  )
  const dataSourceId = database.data_sources?.[0]?.id ?? database.id

  await record(
    ledgerEntry({
      phase: 'create',
      objectId: database.id,
      objectType: 'database',
      purpose: 'live-notion-disposable-database',
      cleanupState: 'created',
    }),
  )
  await record(
    ledgerEntry({
      phase: 'create',
      objectId: dataSourceId,
      objectType: 'data_source',
      purpose: 'live-notion-disposable-data-source',
      cleanupState: 'created',
    }),
  )

  const cleanup = async (inputLedger: LiveFixtureLedger): Promise<LiveFixtureLedger> => {
    ledger = inputLedger

    try {
      const archived = await Effect.runPromise(
        NotionDatabases.archive({ databaseId: database.id }).pipe(Effect.provide(layer)),
      )

      if (archived.in_trash !== true) {
        throw new Error(`live Notion fixture database ${database.id} archive verification failed`)
      }

      await record(
        ledgerEntry({
          phase: 'trash',
          objectId: dataSourceId,
          objectType: 'data_source',
          purpose: 'live-notion-disposable-data-source',
          cleanupState: 'verified-cleaned',
        }),
      )
      await record(
        ledgerEntry({
          phase: 'trash',
          objectId: database.id,
          objectType: 'database',
          purpose: 'live-notion-disposable-database',
          cleanupState: 'verified-cleaned',
        }),
      )
      return ledger
    } catch (cause) {
      await record(
        ledgerEntry({
          phase: 'trash',
          objectId: database.id,
          objectType: 'database',
          purpose: 'live-notion-disposable-database',
          cleanupState: 'cleanup-failed',
        }),
      )
      throw new LiveFixtureCleanupError({ phase: 'trash', cause, ledger })
    }
  }

  return {
    config: { ...config, dataSourceId },
    ledger,
    cleanup,
  }
}

export const runLiveFixtureLifecycle = async (
  config: LiveNotionConfigWithDataSource,
  client: LiveFixtureLifecycleClient,
  options: LiveFixtureLifecycleOptions = {},
): Promise<LiveFixtureLedger> => {
  const writeLedger = options.writeLedger ?? writeLiveFixtureLedger
  let ledger = options.initialLedger ?? emptyLiveFixtureLedger(config)
  let fixture: LiveFixtureObject | undefined

  const persist = async () => {
    await writeLedger({ path: config.ledgerPath, ledger })
  }

  const record = async (entry: LiveFixtureLedgerEntry) => {
    ledger = appendLedgerEntry(ledger, entry)
    await persist()
  }

  const trashFixture = async (
    fixtureToTrash: LiveFixtureObject,
    cleanupState: LiveFixtureLedgerEntry['cleanupState'],
  ) => {
    try {
      await client.trash(fixtureToTrash)
      await record(
        ledgerEntry({
          phase: 'trash',
          objectId: fixtureToTrash.objectId,
          objectType: fixtureToTrash.objectType,
          purpose: fixtureToTrash.purpose,
          cleanupState,
        }),
      )
    } catch (cause) {
      await record(
        ledgerEntry({
          phase: 'trash',
          objectId: fixtureToTrash.objectId,
          objectType: fixtureToTrash.objectType,
          purpose: fixtureToTrash.purpose,
          cleanupState: 'cleanup-failed',
        }),
      )
      throw new LiveFixtureCleanupError({ phase: 'trash', cause, ledger })
    }
  }

  let operationFailure: { readonly cause: unknown } | undefined

  try {
    fixture = await client.create({
      runId: config.runId,
      parentPageId: config.parentPageId,
      dataSourceId: config.dataSourceId,
    })
    await record(
      ledgerEntry({
        phase: 'create',
        objectId: fixture.objectId,
        objectType: fixture.objectType,
        purpose: fixture.purpose,
        cleanupState: 'created',
      }),
    )

    fixture = await client.mutate(fixture)
    await record(
      ledgerEntry({
        phase: 'mutate',
        objectId: fixture.objectId,
        objectType: fixture.objectType,
        purpose: fixture.purpose,
        cleanupState: 'mutated',
      }),
    )

    await client.verify(fixture)
    await record(
      ledgerEntry({
        phase: 'verify',
        objectId: fixture.objectId,
        objectType: fixture.objectType,
        purpose: fixture.purpose,
        cleanupState: 'verified',
      }),
    )
  } catch (cause) {
    operationFailure = { cause }
  }

  if (fixture !== undefined) {
    if (operationFailure !== undefined) {
      await trashFixture(fixture, 'verified-cleaned')
    } else {
      await trashFixture(fixture, 'trashed')

      try {
        await client.restore(fixture)
        await record(
          ledgerEntry({
            phase: 'restore',
            objectId: fixture.objectId,
            objectType: fixture.objectType,
            purpose: fixture.purpose,
            cleanupState: 'restored',
          }),
        )
      } catch (cause) {
        await record(
          ledgerEntry({
            phase: 'restore',
            objectId: fixture.objectId,
            objectType: fixture.objectType,
            purpose: fixture.purpose,
            cleanupState: 'cleanup-failed',
          }),
        )
        throw new LiveFixtureCleanupError({ phase: 'restore', cause, ledger })
      }

      await trashFixture(fixture, 'verified-cleaned')
    }
  }

  if (operationFailure !== undefined) {
    throw operationFailure.cause
  }

  return ledger
}

export const runLiveNotionPreflight = async (
  env: LiveNotionEnv,
  config: LiveNotionConfigWithDataSource,
  options: LiveNotionPreflightOptions = {},
): Promise<LiveNotionPreflightResult> => {
  if (env.token === undefined) {
    throw new Error('live Notion preflight requires a token after configuration validation')
  }

  const gatewayLayer =
    options.gatewayLayer ??
    NotionDataSourceGatewayLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          NotionConfigLive({
            authToken: Redacted.make(env.token),
            retryEnabled: true,
            maxRetries: 2,
            retryBaseDelay: 500,
          }),
          FetchHttpClient.layer,
        ),
      ),
    )

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const gateway = yield* NotionDataSourceGateway
      const preflight = yield* gateway.preflightCapabilities({
        _tag: 'CapabilityPreflightInput',
        dataSourceId: DataSourceId.make(config.dataSourceId),
        requiredCapabilities: config.requiredCapabilities,
      })
      const capabilityGuard = guardCapabilities({
        required: config.requiredCapabilities,
        supported: preflight.supportedCapabilities,
      })

      if (capabilityGuard._tag === 'blocked') {
        throw new Error(capabilityGuard.message)
      }

      yield* gateway
        .queryRows({
          _tag: 'QueryRowsInput',
          dataSourceId: DataSourceId.make(config.dataSourceId),
          queryContract: {
            _tag: 'QueryContract',
            apiVersion: '2026-03-11',
            filter: null,
            sorts: [],
            pageSize: 1,
            highWatermark: null,
            membershipScope: 'all-data-source-rows',
          },
          startCursor: null,
        })
        .pipe(Stream.runHead)

      yield* gateway.retrievePage(PageId.make(config.parentPageId))

      return {
        preflight,
        capabilityGuard,
      }
    }).pipe(Effect.provide(gatewayLayer)),
  )

  const ledger = {
    ...(options.initialLedger ?? emptyLiveFixtureLedger(config)),
    entries: [
      ...(options.initialLedger?.entries ?? []),
      ledgerEntry({
        phase: 'preflight',
        objectId: config.dataSourceId,
        objectType: 'data_source',
        purpose: 'capability-preflight-data-source-access',
        cleanupState: 'verified-cleaned',
      }),
      ledgerEntry({
        phase: 'preflight',
        objectId: config.parentPageId,
        objectType: 'page',
        purpose: 'capability-preflight-parent-page-access',
        cleanupState: 'verified-cleaned',
      }),
    ],
  }

  await (options.writeLedger ?? writeLiveFixtureLedger)({ path: config.ledgerPath, ledger })

  return {
    runId: config.runId,
    dataSourceId: config.dataSourceId,
    parentPageId: config.parentPageId,
    supportedCapabilities: result.preflight.supportedCapabilities,
    missingCapabilities: result.preflight.missingCapabilities,
    ledgerPath: config.ledgerPath,
    ledger,
  }
}
