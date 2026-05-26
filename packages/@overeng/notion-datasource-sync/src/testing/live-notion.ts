import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { FetchHttpClient, type HttpClient } from '@effect/platform'
import { Chunk, Effect, Layer, Redacted, Schema, Stream } from 'effect'

import {
  type NotionConfig,
  NotionBlocks,
  NotionConfigLive,
  NotionDataSources,
  NotionDatabases,
  NotionPages,
} from '@overeng/notion-effect-client'
import { NotionMdGateway, NotionMdGatewayLive } from '@overeng/notion-md'

import { makeNotionMdPageBodySyncPort } from '../body/notion-md.ts'
import { CanonicalOptionValue, type QueryContract } from '../core/commands.ts'
import { canonicalHash } from '../core/canonical.ts'
import {
  AbsolutePath,
  DataSourceId,
  PageId,
  PropertyId,
  PropertyName,
  type CapabilityName,
} from '../core/domain.ts'
import { SyncRootId } from '../core/events.ts'
import { guardCapabilities } from '../core/guards.ts'
import { LocalWorkspacePort, NotionDataSourceGateway, PageBodySyncPort } from '../core/ports.ts'
import { readOnlyGatewayCapabilities } from '../gateway/gateway.ts'
import { NotionDataSourceGatewayLive } from '../gateway/notion.ts'
import { makeFilesystemLocalWorkspacePort } from '../local/workspace.ts'
import { observeRemoteDataSource } from '../sync/observation.ts'

export type LiveNotionEnv = {
  readonly enabled: boolean
  readonly token: string | undefined
  readonly tokenSource: 'NOTION_API_TOKEN' | 'NOTION_TOKEN' | undefined
  readonly parentPageId: string | undefined
  readonly dataSourceId: string | undefined
  readonly e2eLedgerPageId?: string | undefined
  readonly demoPageId?: string | undefined
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
      readonly e2eLedgerPageId?: string | undefined
      readonly demoPageId?: string | undefined
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
  readonly writeLedger?: WriteLiveFixtureLedger
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
  readonly writeLedger?: WriteLiveFixtureLedger
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
    e2eLedgerPageId: env.NOTION_DATASOURCE_SYNC_E2E_LEDGER_PAGE_ID,
    demoPageId: env.NOTION_DATASOURCE_SYNC_DEMO_PAGE_ID,
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
    ...(env.e2eLedgerPageId !== undefined && looksLikeNotionPageId(env.e2eLedgerPageId) === false
      ? ['NOTION_DATASOURCE_SYNC_E2E_LEDGER_PAGE_ID']
      : []),
    ...(env.demoPageId !== undefined && looksLikeNotionPageId(env.demoPageId) === false
      ? ['NOTION_DATASOURCE_SYNC_DEMO_PAGE_ID']
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
    e2eLedgerPageId: env.e2eLedgerPageId,
    demoPageId: env.demoPageId,
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

export type WriteLiveFixtureLedger = (input: {
  readonly path: string
  readonly ledger: LiveFixtureLedger
}) => Promise<void>

export type PublishLiveFixtureLedger = (input: {
  readonly pageId: string
  readonly markdown: string
}) => Promise<void>

export const writeLiveFixtureLedger: WriteLiveFixtureLedger = async (input) => {
  await mkdir(dirname(input.path), { recursive: true })
  await writeFile(input.path, `${JSON.stringify(input.ledger, null, 2)}\n`, 'utf8')
}

export const formatLiveFixtureLedgerMarkdown = (input: {
  readonly ledger: LiveFixtureLedger
  readonly ledgerPath: string
  readonly demoPageId: string | undefined
}): string => {
  const cleanupFailures = input.ledger.entries.filter(
    (entry) => entry.cleanupState === 'cleanup-failed',
  )
  const latestEntry = input.ledger.entries.at(-1)
  const status =
    cleanupFailures.length > 0
      ? 'failed'
      : latestEntry?.cleanupState === 'verified-cleaned'
        ? 'passed'
        : 'running'
  const entries =
    input.ledger.entries.length === 0
      ? ['No ledger entries recorded yet.']
      : input.ledger.entries.map(
          (entry) =>
            `- ${entry.phase}: ${entry.objectType} ${entry.objectId} - ${entry.purpose} - ${entry.cleanupState}`,
        )

  return [
    '# notion datasource sync e2e run ledger',
    '',
    `Latest status: **${status}**`,
    '',
    `- Run ID: ${input.ledger.runId}`,
    `- Notion API version: ${input.ledger.notionVersion}`,
    `- Local ledger artifact: ${input.ledgerPath}`,
    `- Git SHA: ${process.env.GITHUB_SHA ?? process.env.GIT_COMMIT ?? 'local'}`,
    `- GitHub run: ${process.env.GITHUB_RUN_ID ?? 'local'}`,
    ...(input.demoPageId === undefined ? [] : [`- Demo page id: ${input.demoPageId}`]),
    ...(latestEntry === undefined
      ? []
      : [`- Latest entry: ${latestEntry.phase} ${latestEntry.cleanupState}`]),
    ...(cleanupFailures.length === 0
      ? []
      : [`- Cleanup failures: ${cleanupFailures.length.toString()}`]),
    '',
    '## Ledger entries',
    '',
    ...entries,
  ].join('\n')
}

export const makeLiveFixtureLedgerWriter = (input: {
  readonly env: LiveNotionEnv
  readonly config: ConfiguredLiveNotionConfig
  readonly writeLocalLedger?: WriteLiveFixtureLedger
  readonly publishLedger?: PublishLiveFixtureLedger
}): WriteLiveFixtureLedger => {
  const writeLocalLedger = input.writeLocalLedger ?? writeLiveFixtureLedger

  return async (entry) => {
    await writeLocalLedger(entry)

    if (input.config.e2eLedgerPageId === undefined) {
      return
    }

    const markdown = formatLiveFixtureLedgerMarkdown({
      ledger: entry.ledger,
      ledgerPath: entry.path,
      demoPageId: input.config.demoPageId,
    })

    if (input.publishLedger !== undefined) {
      await input.publishLedger({ pageId: input.config.e2eLedgerPageId, markdown })
      return
    }

    if (input.env.token === undefined) {
      throw new Error(
        'live Notion ledger page publishing requires a token after configuration validation',
      )
    }

    await Effect.runPromise(
      NotionPages.updateMarkdown({
        pageId: input.config.e2eLedgerPageId,
        type: 'replace_content',
        new_str: markdown,
        allow_deleting_content: true,
      }).pipe(Effect.provide(makeNotionLiveLayer(input.env.token))),
    )
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const text = (content: string) => ({ type: 'text', text: { content } })

const title = (content: string) => ({ title: [text(content)] })

const richText = (content: string) => ({ rich_text: [text(content)] })

const paragraphBlock = (content: string) => ({
  object: 'block',
  type: 'paragraph',
  paragraph: richText(content),
})

const bulletedBlock = (content: string) => ({
  object: 'block',
  type: 'bulleted_list_item',
  bulleted_list_item: richText(content),
})

const codeBlock = (content: string) => ({
  object: 'block',
  type: 'code',
  code: {
    rich_text: [text(content)],
    language: 'plain text',
  },
})

const select = (name: string) => ({ select: { name } })

const multiSelect = (names: ReadonlyArray<string>) => ({
  multi_select: names.map((name) => ({ name })),
})

const date = (start: string) => ({ date: { start } })

const checkbox = (checked: boolean) => ({ checkbox: checked })

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

const isAlreadyArchivedNotionError = (cause: unknown): boolean => {
  const seen = new Set<unknown>()
  const visit = (value: unknown): boolean => {
    if (value === undefined || value === null || seen.has(value) === true) return false
    seen.add(value)
    if (String(value).toLowerCase().includes('archived') === true) return true
    if (typeof value !== 'object') return false
    if ('message' in value && String(value.message).toLowerCase().includes('archived') === true) {
      return true
    }
    if ('cause' in value && visit(value.cause) === true) return true
    if ('error' in value && visit(value.error) === true) return true
    if ('fiberFailure' in value && visit(value.fiberFailure) === true) return true
    return false
  }

  return visit(cause)
}

export type LiveNotionDemoShowcaseResult = {
  readonly runId: string
  readonly demoPageId: string
  readonly databaseId: string
  readonly dataSourceId: string
  readonly rowIds: ReadonlyArray<string>
  readonly observation: {
    readonly pages: number
    readonly rows: number
    readonly materializedBodies: number
    readonly observedProperties: number
    readonly incompleteProperties: number
    readonly events: number
  }
  readonly workspaceRoot: string
}

const demoDatabaseTitlePrefix = 'notion datasource sync automated demo data'
const staleDemoDatabaseTitlePrefixes = [
  demoDatabaseTitlePrefix,
  'notion datasource sync live data source',
  'notion ds sync relation',
] as const

const demoInitialMarkdown = (input: { readonly runId: string }): string =>
  [
    '# notion datasource sync automated demo',
    '',
    `Current run: ${input.runId}`,
    '',
    'This page is refreshed by the live demo. The inline data source below is created from scratch for the current run, then observed through datasource-sync with the real Notion gateway and NotionMD body adapter.',
    '',
    '## What this run demonstrates',
    '',
    '- Disposable Notion data source creation under the configured demo page.',
    '- Realistic row properties across title, rich text, number, checkbox, date, select, and multi-select.',
    '- Paginated datasource query observation with a small page size.',
    '- NotionMD body observation and workspace materialization for row pages.',
    '- A filtered high-watermark query contract on the same live data source.',
    '',
    'The final verification summary is appended below the data source after the run completes.',
  ].join('\n')

const demoRowMarkdown = (input: { readonly runId: string; readonly index: number }): string =>
  [
    `# Demo row ${input.index.toString()}`,
    '',
    `Generated by notion-datasource-sync demo run ${input.runId}.`,
    '',
    '## Body content',
    '',
    '- This body was written through the Notion markdown endpoint.',
    '- datasource-sync observes it through the NotionMD body adapter.',
    '- The filesystem workspace receives a materialized body placeholder with sidecar identity.',
  ].join('\n')

const demoRowProperties = (input: { readonly runId: string; readonly index: number }) => {
  const status = input.index % 2 === 0 ? 'active' : 'review'
  return {
    Name: title(`Demo row ${input.index.toString()} ${input.runId}`),
    Status: select(status),
    Score: { number: input.index * 10 },
    Done: checkbox(input.index % 3 === 0),
    Due: date(`2026-05-${String(20 + input.index).padStart(2, '0')}`),
    Tags: multiSelect(input.index % 2 === 0 ? ['high-cardinality', 'body'] : ['filter', 'datatype']),
    Notes: richText(`Observed note ${input.index.toString()} for ${input.runId}`),
  }
}

const demoDataSourceProperties = {
  Name: { title: {} },
  Status: {
    select: {
      options: [
        { name: 'active', color: 'green' },
        { name: 'review', color: 'yellow' },
      ],
    },
  },
  Score: { number: { format: 'number' } },
  Done: { checkbox: {} },
  Due: { date: {} },
  Tags: {
    multi_select: {
      options: [
        { name: 'high-cardinality', color: 'blue' },
        { name: 'body', color: 'purple' },
        { name: 'filter', color: 'orange' },
        { name: 'datatype', color: 'pink' },
      ],
    },
  },
  Notes: { rich_text: {} },
}

const formatDemoVerificationBlocks = (result: LiveNotionDemoShowcaseResult) => [
  {
    object: 'block',
    type: 'heading_2',
    heading_2: richText('Verification summary'),
  },
  paragraphBlock('The latest automated demo run completed against live Notion.'),
  bulletedBlock(`Run ID: ${result.runId}`),
  bulletedBlock(`Data source ID: ${result.dataSourceId}`),
  bulletedBlock(`Rows created: ${result.rowIds.length.toString()}`),
  bulletedBlock(
    `Observation: ${result.observation.pages.toString()} query pages, ${result.observation.rows.toString()} rows, ${result.observation.events.toString()} sync events`,
  ),
  bulletedBlock(
    `Bodies materialized: ${result.observation.materializedBodies.toString()}; properties observed: ${result.observation.observedProperties.toString()}; incomplete properties: ${result.observation.incompleteProperties.toString()}`,
  ),
  codeBlock(
    `NOTION_DATASOURCE_SYNC_DEMO_PAGE_ID=${result.demoPageId}\nNOTION_DATASOURCE_SYNC_LIVE=1 pnpm --dir packages/@overeng/notion-datasource-sync exec vitest run src/e2e/live-notion.e2e.test.ts --config vitest.config.ts`,
  ),
]

const collectBlocks = (pageId: string) =>
  NotionBlocks.retrieveChildrenStream({ blockId: pageId, pageSize: 100 }).pipe(
    Stream.runCollect,
    Effect.map(Chunk.toReadonlyArray),
  )

const archiveDemoDatabase = (databaseId: string) =>
  NotionDatabases.archive({ databaseId }).pipe(
    Effect.catchAll(() =>
      NotionDatabases.update({ databaseId, in_trash: false }).pipe(
        Effect.zipRight(NotionDatabases.archive({ databaseId })),
        Effect.ignore,
      ),
    ),
    Effect.zipRight(NotionBlocks.delete({ blockId: databaseId }).pipe(Effect.ignore)),
    Effect.asVoid,
  )

const cleanupPreviousDemoBlocks = (pageId: string) =>
  Effect.gen(function* () {
    const children = yield* collectBlocks(pageId)
    yield* Effect.forEach(
      children,
      (block) => {
        if (block.type !== 'child_database') return Effect.void
        const childDatabase = block.child_database
        const childDatabaseTitle =
          typeof childDatabase === 'object' &&
          childDatabase !== null &&
          'title' in childDatabase &&
          typeof childDatabase.title === 'string'
            ? childDatabase.title
            : undefined
        if (
          childDatabaseTitle !== undefined &&
          staleDemoDatabaseTitlePrefixes.some((prefix) => childDatabaseTitle.startsWith(prefix))
        ) {
          return archiveDemoDatabase(block.id)
        }
        return Effect.void
      },
      { concurrency: 2 },
    )
  })

const databaseIdFromNotionUrl = (url: string): string | undefined =>
  /notion\.so\/(?:[^/\s"]*-)?([0-9a-f]{32})/iu.exec(url)?.[1]

const cleanupPreviousDemoMarkdownDatabases = (pageId: string) =>
  Effect.gen(function* () {
    const markdown = yield* NotionPages.getMarkdown({ pageId })
    const databaseMatches = markdown.markdown.matchAll(
      /<database\b[^>]*\burl="(?<url>[^"]+)"[^>]*>(?<title>[^<]+)<\/database>/giu,
    )
    yield* Effect.forEach(
      [...databaseMatches],
      (match) => {
        const title = match.groups?.title
        const url = match.groups?.url
        const databaseId = url === undefined ? undefined : databaseIdFromNotionUrl(url)
        if (
          title === undefined ||
          databaseId === undefined ||
          staleDemoDatabaseTitlePrefixes.some((prefix) => title.startsWith(prefix)) === false
        ) {
          return Effect.void
        }
        return archiveDemoDatabase(databaseId)
      },
      { concurrency: 2 },
    )
  })

const resolvePropertyId = ({
  properties,
  name,
}: {
  readonly properties: Record<string, unknown>
  readonly name: string
}): string => {
  const property = properties[name]
  if (isRecord(property) === false || typeof property.id !== 'string') {
    throw new Error(`demo data source does not expose expected property ${name}`)
  }
  return property.id
}

export const runLiveNotionDemoShowcase = async (
  env: LiveNotionEnv,
  config: ConfiguredLiveNotionConfig,
): Promise<LiveNotionDemoShowcaseResult> => {
  if (env.token === undefined) {
    throw new Error('live Notion demo showcase requires a token after configuration validation')
  }
  if (config.demoPageId === undefined) {
    throw new Error('live Notion demo showcase requires NOTION_DATASOURCE_SYNC_DEMO_PAGE_ID')
  }
  const demoPageId = config.demoPageId

  const layer = makeNotionLiveLayer(env.token)
  const run = <A, E>(effect: Effect.Effect<A, E, NotionConfig | HttpClient.HttpClient>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)))

  const database = await run(
    Effect.gen(function* () {
      yield* cleanupPreviousDemoBlocks(demoPageId)
      yield* cleanupPreviousDemoMarkdownDatabases(demoPageId)
      yield* NotionPages.updateMarkdown({
        pageId: demoPageId,
        type: 'replace_content',
        new_str: demoInitialMarkdown({ runId: config.runId }),
        allow_deleting_content: true,
      })
      yield* cleanupPreviousDemoBlocks(demoPageId)
      yield* cleanupPreviousDemoMarkdownDatabases(demoPageId)

      return yield* NotionDatabases.create({
        parent: { type: 'page_id', page_id: demoPageId },
        title: [text(`${demoDatabaseTitlePrefix} (${config.runId})`)],
        is_inline: true,
        properties: { Name: { title: {} } },
      })
    }),
  )
  const resolvedDatabase = await run(NotionDatabases.retrieve({ databaseId: database.id }))
  const dataSourceId =
    resolvedDatabase.data_sources?.[0]?.id ?? database.data_sources?.[0]?.id ?? database.id
  if (dataSourceId === undefined) {
    throw new Error('live Notion demo showcase could not resolve created data source id')
  }

  await run(NotionDataSources.update({ dataSourceId, properties: demoDataSourceProperties }))

  const rowIds = await run(
    Effect.forEach(
      Array.from({ length: 6 }, (_, index) => index + 1),
      (index) =>
        NotionPages.create({
          parent: { type: 'data_source_id', data_source_id: dataSourceId },
          properties: demoRowProperties({ runId: config.runId, index }),
          markdown: demoRowMarkdown({ runId: config.runId, index }),
        }).pipe(Effect.map((page) => page.id)),
      { concurrency: 2 },
    ),
  )

  const dataSource = await run(NotionDataSources.retrieve({ dataSourceId }))
  const notesPropertyId = resolvePropertyId({ properties: dataSource.properties, name: 'Notes' })
  const statusPropertyId = resolvePropertyId({ properties: dataSource.properties, name: 'Status' })
  const workspaceRoot = Schema.decodeUnknownSync(AbsolutePath)(
    await mkdtemp(join(tmpdir(), 'notion-ds-sync-demo-')),
  )
  const rootId = Schema.decodeUnknownSync(SyncRootId)(`demo:${config.runId}`)
  const highWatermark = Schema.decodeUnknownSync(Schema.DateTimeUtc)('2026-05-20T00:00:00.000Z')
  const queryContract: QueryContract = {
    _tag: 'QueryContract',
    apiVersion: '2026-03-11',
    filter: null,
    sorts: [
      {
        _tag: 'CanonicalNotionSort',
        propertyId: PropertyId.make(statusPropertyId),
        direction: 'ascending',
      },
    ],
    pageSize: 2,
    highWatermark: null,
    membershipScope: 'all-data-source-rows',
  }
  const filteredContract: QueryContract = {
    ...queryContract,
    filter: {
      _tag: 'property_value',
      propertyId: PropertyId.make(statusPropertyId),
      operator: 'equals',
      value: {
        _tag: 'select',
        option: Schema.decodeUnknownSync(CanonicalOptionValue)({
          _tag: 'CanonicalOptionValue',
          name: Schema.decodeUnknownSync(PropertyName)('active'),
        }),
      },
    },
    highWatermark,
    membershipScope: 'explicit-filter',
  }

  try {
    const observationLayer = Layer.mergeAll(
      NotionDataSourceGatewayLive.pipe(Layer.provide(layer)),
      NotionMdGatewayLive.pipe(Layer.provide(layer)),
    )
    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const notionMdGateway = yield* NotionMdGateway
        const bodyPort = makeNotionMdPageBodySyncPort({ gateway: notionMdGateway })
        const workspace = makeFilesystemLocalWorkspacePort({ root: workspaceRoot })
        const first = yield* observeRemoteDataSource({
          rootId,
          dataSourceId: DataSourceId.make(dataSourceId),
          workspaceRoot,
          queryContract,
          schemaProperties: [
            {
              propertyId: PropertyId.make(notesPropertyId),
              configHash: canonicalHash(dataSource.properties.Notes),
              writeClass: 'writable',
            },
          ],
          materializeBodies: true,
          requiredCapabilities: strictLivePreflightCapabilities,
        }).pipe(
          Effect.provideService(PageBodySyncPort, bodyPort),
          Effect.provideService(LocalWorkspacePort, workspace),
        )
        const filtered = yield* observeRemoteDataSource({
          rootId,
          dataSourceId: DataSourceId.make(dataSourceId),
          workspaceRoot,
          queryContract: filteredContract,
          schemaProperties: [],
          materializeBodies: false,
          requiredCapabilities: strictLivePreflightCapabilities,
        }).pipe(
          Effect.provideService(PageBodySyncPort, bodyPort),
          Effect.provideService(LocalWorkspacePort, workspace),
        )

        return { first, filtered }
      }).pipe(Effect.provide(observationLayer)),
    )

    const result: LiveNotionDemoShowcaseResult = {
      runId: config.runId,
      demoPageId,
      databaseId: database.id,
      dataSourceId,
      rowIds,
      observation: {
        pages: observed.first.query.pages + observed.filtered.query.pages,
        rows: observed.first.query.rows + observed.filtered.query.rows,
        materializedBodies: observed.first.materialized.length,
        observedProperties: observed.first.properties.observed,
        incompleteProperties: observed.first.properties.incomplete,
        events: observed.first.events.length + observed.filtered.events.length,
      },
      workspaceRoot,
    }

    await run(
      NotionBlocks.append({
        blockId: demoPageId,
        children: formatDemoVerificationBlocks(result),
      }),
    )

    return result
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
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

  const writeLedger = options.writeLedger ?? makeLiveFixtureLedgerWriter({ env, config })
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
      if (isAlreadyArchivedNotionError(cause) === true) {
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
      }
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
      if (cleanupState === 'verified-cleaned' && isAlreadyArchivedNotionError(cause) === true) {
        await record(
          ledgerEntry({
            phase: 'trash',
            objectId: fixtureToTrash.objectId,
            objectType: fixtureToTrash.objectType,
            purpose: fixtureToTrash.purpose,
            cleanupState: 'verified-cleaned',
          }),
        )
        return
      }
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

export const runLiveFixtureSoak = async (
  config: LiveNotionConfigWithDataSource,
  client: LiveFixtureLifecycleClient,
  options: LiveFixtureLifecycleOptions & {
    readonly scenarioName: string
    readonly cycles: number
  },
): Promise<LiveFixtureLedger> => {
  if (options.cycles < 1 || Number.isInteger(options.cycles) === false) {
    throw new Error('live fixture soak requires a positive integer cycle count')
  }

  const writeLedger = options.writeLedger ?? writeLiveFixtureLedger
  let ledger = options.initialLedger ?? emptyLiveFixtureLedger(config)

  const persist = async () => {
    await writeLedger({ path: config.ledgerPath, ledger })
  }

  const record = async (entry: LiveFixtureLedgerEntry) => {
    ledger = appendLedgerEntry(ledger, entry)
    await persist()
  }

  await record(
    ledgerEntry({
      phase: 'verify',
      objectId: config.dataSourceId,
      objectType: 'data_source',
      purpose: `${options.scenarioName}:start:${options.cycles.toString()}-cycles`,
      cleanupState: 'verified',
    }),
  )

  for (let cycle = 1; cycle <= options.cycles; cycle += 1) {
    ledger = await runLiveFixtureLifecycle(config, client, {
      initialLedger: ledger,
      writeLedger,
    })
    await record(
      ledgerEntry({
        phase: 'verify',
        objectId: config.dataSourceId,
        objectType: 'data_source',
        purpose: `${options.scenarioName}:cycle:${cycle.toString()}`,
        cleanupState: 'verified',
      }),
    )
  }

  await record(
    ledgerEntry({
      phase: 'verify',
      objectId: config.dataSourceId,
      objectType: 'data_source',
      purpose: `${options.scenarioName}:complete`,
      cleanupState: 'verified-cleaned',
    }),
  )

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

  await (options.writeLedger ?? makeLiveFixtureLedgerWriter({ env, config }))({
    path: config.ledgerPath,
    ledger,
  })

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
