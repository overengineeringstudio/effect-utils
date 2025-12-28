import { FetchHttpClient, type HttpClient } from '@effect/platform'
import { Layer } from 'effect'
import { NotionConfig } from '../../config.ts'

/** Skip integration tests if no token is available */
export const SKIP_INTEGRATION = !process.env.NOTION_TOKEN

/** Skip mutation tests in CI to avoid corrupting test fixtures */
export const SKIP_MUTATIONS = process.env.CI === 'true'

/** Test fixture IDs from the Notion test environment */
export const TEST_IDS = {
  rootPage: '2d7f141b18dc803ab532f33fb8c5d434',
  database: 'df25270a27a1437cb4fb0a0038b570ba',
  dataSource: '939ffd13-5698-4dcc-bc44-42b282fba959',
  pageWithBlocks: '2d7f141b18dc8112b6e8d85570594dba',
  emptyPage: '2d7f141b18dc8191ad8ed68a5351573c',
  nestedPage: '1e6342690eb645e98068c99ff15298e6',
  /** Database row IDs */
  rows: {
    alpha: '2d7f141b18dc81708454e1a89fd84e64',
    beta: '2d7f141b18dc81c0bd0cf3ccb0f74d58',
    gamma: '2d7f141b18dc812d9445d9bed26af852',
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
