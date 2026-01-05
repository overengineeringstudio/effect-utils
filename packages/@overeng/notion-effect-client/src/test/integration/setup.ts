import { FetchHttpClient, type HttpClient } from '@effect/platform'
import { Layer } from 'effect'

import { NotionConfig } from '../../config.ts'

/** Skip integration tests if no token is available */
export const SKIP_INTEGRATION = !process.env.NOTION_TOKEN

/** Skip mutation tests in CI to avoid corrupting test fixtures */
export const SKIP_MUTATIONS = process.env.CI === 'true'

/** Test fixture IDs from the Notion test environment */
export const TEST_IDS = {
  /** Root page: @overeng/notion-effect-client API test env */
  rootPage: '2dbf141b18dc8133b921c786d2b00ecf',
  /** Test Database */
  database: '2adfbc6627894baf94e5e919a826c3f4',
  /** Test Database data source */
  dataSource: '7d8ab748-1f94-4211-a128-883256e3f559',
  /** Page with various block types */
  pageWithBlocks: '2dbf141b18dc8134b0a3e197c32ca3e8',
  /** Empty page for mutation tests */
  emptyPage: '2dbf141b18dc818e8439ec9ff7d889eb',
  /** Page with deeply nested blocks for recursive fetching tests */
  nestedPage: '2dbf141b18dc8171939df328b6ad9735',
  /** Page with rich text formatting for testing */
  richTextPage: '2dbf141b18dc8180965adcff3dd7178b',
  /** Database row IDs */
  rows: {
    alpha: '2dbf141b18dc81debf3fca3c05af1000',
    beta: '2dbf141b18dc8161b35cf708809be7e0',
    gamma: '2dbf141b18dc81b39286dd8d74c29775',
  },
} as const

/** Live NotionConfig layer using environment token */
export const NotionConfigLive = Layer.succeed(NotionConfig, {
  authToken: process.env.NOTION_TOKEN ?? '',
  retryEnabled: true,
  maxRetries: 3,
  retryBaseDelay: 1000,
})

/** Complete layer for integration tests with real HTTP client */
export const IntegrationTestLayer = Layer.mergeAll(
  NotionConfigLive,
  FetchHttpClient.layer,
) satisfies Layer.Layer<NotionConfig | HttpClient.HttpClient>
