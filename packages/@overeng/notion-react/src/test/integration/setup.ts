import { FetchHttpClient, type HttpClient } from '@effect/platform'
import { Layer, Redacted } from 'effect'

import { NotionConfig } from '@overeng/notion-effect-client'

/** Skip integration tests if no token is available */
export const SKIP_INTEGRATION = !process.env.NOTION_TOKEN

/** Live NotionConfig layer using environment token */
export const NotionConfigLive = Layer.succeed(NotionConfig, {
  authToken: Redacted.make(process.env.NOTION_TOKEN ?? ''),
  retryEnabled: true,
  maxRetries: 3,
  retryBaseDelay: 1000,
})

/** Complete layer for integration tests with real HTTP client */
export const IntegrationTestLayer = Layer.mergeAll(
  NotionConfigLive,
  FetchHttpClient.layer,
) satisfies Layer.Layer<NotionConfig | HttpClient.HttpClient>
