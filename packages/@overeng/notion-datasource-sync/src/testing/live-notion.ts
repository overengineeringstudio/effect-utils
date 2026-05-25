import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { FetchHttpClient } from '@effect/platform'
import { Effect, Layer, Redacted, Stream } from 'effect'

import { NotionConfigLive } from '@overeng/notion-effect-client'

import { DataSourceId, PageId, type CapabilityName } from '../domain.ts'
import { NotionDataSourceGatewayLive } from '../gateway-notion.ts'
import { guardCapabilities } from '../guards.ts'
import { NotionDataSourceGateway } from '../ports.ts'

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
      readonly dataSourceId: string
      readonly notionVersion: '2026-03-11'
      readonly requiredCapabilities: ReadonlyArray<CapabilityName>
      readonly ledgerPath: string
    }

export type LiveFixtureLedgerEntry = {
  readonly objectId: string
  readonly objectType: 'page' | 'data_source' | 'database' | 'block' | 'file'
  readonly purpose: string
  readonly cleanupState: 'created' | 'trashed' | 'verified-cleaned' | 'cleanup-failed'
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
}

export type LiveNotionPreflightOptions = {
  readonly gatewayLayer?: Layer.Layer<NotionDataSourceGateway>
  readonly writeLedger?: typeof writeLiveFixtureLedger
}

export const defaultLivePreflightCapabilities = [
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
    ...(dataSourceId === undefined ? ['NOTION_DATASOURCE_SYNC_DATA_SOURCE_ID'] : []),
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
    parentPageId === undefined ||
    dataSourceId === undefined
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

export const emptyLiveFixtureLedger = (config: Extract<LiveNotionConfig, { _tag: 'configured' }>) =>
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

export const writeLiveFixtureLedger = async (input: {
  readonly path: string
  readonly ledger: LiveFixtureLedger
}): Promise<void> => {
  await mkdir(dirname(input.path), { recursive: true })
  await writeFile(input.path, `${JSON.stringify(input.ledger, null, 2)}\n`, 'utf8')
}

export const runLiveNotionPreflight = async (
  env: LiveNotionEnv,
  config: Extract<LiveNotionConfig, { _tag: 'configured' }>,
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
    ...emptyLiveFixtureLedger(config),
    entries: [
      ledgerEntry({
        objectId: config.dataSourceId,
        objectType: 'data_source',
        purpose: 'capability-preflight-data-source-access',
        cleanupState: 'verified-cleaned',
      }),
      ledgerEntry({
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
  }
}
