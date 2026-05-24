import { FetchHttpClient, type HttpClient } from '@effect/platform'
import { Effect, Layer, Redacted } from 'effect'

import { NotionBlocks } from '../../blocks.ts'
import { NotionConfig } from '../../config.ts'
import { NotionDataSources } from '../../data-sources.ts'
import { NotionDatabases } from '../../databases.ts'
import { NotionPages } from '../../pages.ts'

/** Skip integration tests if no token is available */
export const SKIP_INTEGRATION = !process.env.NOTION_API_TOKEN

/** Dedicated scratch parent used for provisioned live fixtures. */
export const TEST_PARENT_PAGE_ID =
  process.env.NOTION_TEST_PARENT_PAGE_ID ?? process.env.NOTION_MD_TEST_PARENT_PAGE_ID ?? ''

/** Skip fixture-backed tests unless a writable parent is configured. */
export const SKIP_FIXTURE_INTEGRATION = SKIP_INTEGRATION || TEST_PARENT_PAGE_ID.length === 0

/** Mutation tests are safe once fixtures are provisioned under the scratch parent. */
export const SKIP_MUTATIONS = SKIP_FIXTURE_INTEGRATION

/** IDs for live fixtures provisioned under the configured scratch parent. */
export interface IntegrationTestIds {
  /** Root page: @overeng/notion-effect-client API test env */
  readonly rootPage: string
  /** Test Database */
  readonly database: string
  /** Test Database data source */
  readonly dataSource: string
  /** Page with various block types */
  readonly pageWithBlocks: string
  /** Empty page for mutation tests */
  readonly emptyPage: string
  /** Page with deeply nested blocks for recursive fetching tests */
  readonly nestedPage: string
  /** Page with rich text formatting for testing */
  readonly richTextPage: string
  /** Database row IDs */
  readonly rows: {
    readonly alpha: string
    readonly beta: string
    readonly gamma: string
  }
  readonly dumpDataSource: string
  readonly largeDataSource: string
  readonly deepNestingPage: string
}

const emptyTestIds = {
  rootPage: '',
  database: '',
  dataSource: '',
  pageWithBlocks: '',
  emptyPage: '',
  nestedPage: '',
  richTextPage: '',
  rows: {
    alpha: '',
    beta: '',
    gamma: '',
  },
  dumpDataSource: '',
  largeDataSource: '',
  deepNestingPage: '',
} satisfies IntegrationTestIds

/** Test fixture IDs provisioned for the current Vitest process. */
export let TEST_IDS: IntegrationTestIds = emptyTestIds

/** Live NotionConfig layer using environment token */
export const NotionConfigLive = Layer.succeed(NotionConfig, {
  authToken: Redacted.make(process.env.NOTION_API_TOKEN ?? ''),
  retryEnabled: true,
  maxRetries: 3,
  retryBaseDelay: 1000,
})

/** Complete layer for integration tests with real HTTP client */
export const IntegrationTestLayer = Layer.mergeAll(
  NotionConfigLive,
  FetchHttpClient.layer,
) satisfies Layer.Layer<NotionConfig | HttpClient.HttpClient>

const text = (content: string, annotations?: Record<string, boolean>) => ({
  type: 'text',
  text: { content },
  ...(annotations !== undefined ? { annotations } : {}),
})

const title = (content: string) => ({
  title: [text(content)],
})

const paragraph = (content: string, annotations?: Record<string, boolean>) => ({
  object: 'block',
  type: 'paragraph',
  paragraph: { rich_text: [text(content, annotations)] },
})

const fixturePrefix = 'effect-utils notion live fixture'

const createFixturePage = (opts: {
  readonly parentPageId: string
  readonly title: string
  readonly children?: readonly unknown[]
}) =>
  NotionPages.create({
    parent: { type: 'page_id', page_id: opts.parentPageId },
    properties: { title: title(opts.title) },
    ...(opts.children !== undefined ? { children: opts.children } : {}),
  })

const provisionFixtures = async (): Promise<IntegrationTestIds> => {
  if (SKIP_FIXTURE_INTEGRATION === true) return emptyTestIds

  return await Effect.runPromise(
    Effect.gen(function* () {
      yield* NotionBlocks.retrieve({ blockId: TEST_PARENT_PAGE_ID })

      const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
      const root = yield* createFixturePage({
        parentPageId: TEST_PARENT_PAGE_ID,
        title: `${fixturePrefix}: ${stamp}`,
      })

      const pageWithBlocks = yield* createFixturePage({
        parentPageId: root.id,
        title: 'Page with Blocks',
        children: [
          {
            object: 'block',
            type: 'heading_1',
            heading_1: { rich_text: [text('Heading 1')] },
          },
          {
            object: 'block',
            type: 'heading_2',
            heading_2: { rich_text: [text('Heading 2')] },
          },
          {
            object: 'block',
            type: 'heading_3',
            heading_3: { rich_text: [text('Heading 3')] },
          },
          paragraph('simple paragraph'),
          {
            object: 'block',
            type: 'bulleted_list_item',
            bulleted_list_item: { rich_text: [text('First bullet')] },
          },
          {
            object: 'block',
            type: 'numbered_list_item',
            numbered_list_item: { rich_text: [text('First numbered')] },
          },
          {
            object: 'block',
            type: 'quote',
            quote: { rich_text: [text('This is a quote')] },
          },
          {
            object: 'block',
            type: 'code',
            code: {
              rich_text: [text('console.log("Hello, World!")')],
              language: 'typescript',
            },
          },
          {
            object: 'block',
            type: 'to_do',
            to_do: { rich_text: [text('Unchecked todo')], checked: false },
          },
          {
            object: 'block',
            type: 'to_do',
            to_do: { rich_text: [text('Checked todo')], checked: true },
          },
          {
            object: 'block',
            type: 'toggle',
            toggle: { rich_text: [text('Toggle summary')] },
          },
          { object: 'block', type: 'divider', divider: {} },
          {
            object: 'block',
            type: 'callout',
            callout: {
              rich_text: [text('Remember this callout')],
            },
          },
          {
            object: 'block',
            type: 'equation',
            equation: { expression: 'E = mc^2' },
          },
        ],
      })

      const nestedPage = yield* createFixturePage({
        parentPageId: root.id,
        title: 'Nested Page',
        children: [
          {
            object: 'block',
            type: 'toggle',
            toggle: {
              rich_text: [text('Level 1 toggle')],
              children: [
                paragraph('Level 2 paragraph'),
                {
                  object: 'block',
                  type: 'bulleted_list_item',
                  bulleted_list_item: {
                    rich_text: [text('Nested bullet')],
                    children: [paragraph('Level 3 paragraph')],
                  },
                },
              ],
            },
          },
        ],
      })

      const richTextPage = yield* createFixturePage({
        parentPageId: root.id,
        title: 'Rich Text Page',
        children: [
          {
            object: 'block',
            type: 'heading_2',
            heading_2: { rich_text: [text('Rich heading', { bold: true })] },
          },
          paragraph('Bold italic paragraph', { bold: true, italic: true }),
        ],
      })

      const emptyPage = yield* createFixturePage({
        parentPageId: root.id,
        title: 'Empty Page',
      })

      const database = yield* NotionDatabases.create({
        parent: { type: 'page_id', page_id: root.id },
        title: [text('Test Database')],
        properties: {
          Name: { title: {} },
          Status: {
            select: {
              options: [
                { name: 'active', color: 'green' },
                { name: 'draft', color: 'gray' },
              ],
            },
          },
          Priority: { number: { format: 'number' } },
          Done: { checkbox: {} },
        },
      })
      const dataSourceId = database.data_sources?.[0]?.id ?? database.id
      yield* NotionDataSources.update({
        dataSourceId,
        properties: {
          Status: {
            select: {
              options: [
                { name: 'active', color: 'green' },
                { name: 'draft', color: 'gray' },
              ],
            },
          },
          Priority: { number: { format: 'number' } },
          Done: { checkbox: {} },
        },
      })

      const alpha = yield* NotionPages.create({
        parent: { type: 'data_source_id', data_source_id: dataSourceId },
        properties: {
          Name: title('Alpha'),
          Status: { select: { name: 'active' } },
          Priority: { number: 1 },
          Done: { checkbox: true },
        },
      })
      const beta = yield* NotionPages.create({
        parent: { type: 'data_source_id', data_source_id: dataSourceId },
        properties: {
          Name: title('Beta'),
          Status: { select: { name: 'draft' } },
          Priority: { number: 2 },
          Done: { checkbox: false },
        },
      })
      const gamma = yield* NotionPages.create({
        parent: { type: 'data_source_id', data_source_id: dataSourceId },
        properties: {
          Name: title('Gamma'),
          Status: { select: { name: 'active' } },
          Priority: { number: 3 },
          Done: { checkbox: true },
        },
      })

      return {
        rootPage: root.id,
        database: database.id,
        dataSource: dataSourceId,
        pageWithBlocks: pageWithBlocks.id,
        emptyPage: emptyPage.id,
        nestedPage: nestedPage.id,
        richTextPage: richTextPage.id,
        rows: {
          alpha: alpha.id,
          beta: beta.id,
          gamma: gamma.id,
        },
        dumpDataSource: dataSourceId,
        largeDataSource: dataSourceId,
        deepNestingPage: nestedPage.id,
      } satisfies IntegrationTestIds
    }).pipe(Effect.provide(IntegrationTestLayer)),
  )
}

const cleanupFixtures = async (ids: IntegrationTestIds): Promise<void> => {
  if (ids.rootPage.length === 0) return

  await Effect.runPromise(
    Effect.gen(function* () {
      yield* NotionDatabases.archive({ databaseId: ids.database }).pipe(Effect.ignore)
      yield* NotionPages.archive({ pageId: ids.rootPage }).pipe(Effect.ignore)
    }).pipe(Effect.provide(IntegrationTestLayer)),
  )
}

let fixturePromise: Promise<IntegrationTestIds> | undefined

/** Provision the current Vitest process fixtures once and publish their IDs. */
export const setupIntegrationFixtures = async (): Promise<IntegrationTestIds> => {
  fixturePromise ??= provisionFixtures()
  TEST_IDS = await fixturePromise
  return TEST_IDS
}

/** Archive fixtures created by {@link setupIntegrationFixtures}. */
export const teardownIntegrationFixtures = async (): Promise<void> => {
  if (fixturePromise === undefined) return
  const ids = await fixturePromise
  await cleanupFixtures(ids)
  fixturePromise = undefined
  TEST_IDS = emptyTestIds
}
