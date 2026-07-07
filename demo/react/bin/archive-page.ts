/**
 * BACKSTAGE helper. Archives (soft-deletes) the Notion page whose id is passed
 * as argv[2]. Best-effort: never fails the caller. Used by reset.sh.
 */
import { FetchHttpClient } from '@effect/platform'
import { Effect, Layer, Redacted } from 'effect'

import { NotionConfig, NotionPages } from '@overeng/notion-effect-client'

const pageId = process.argv[2] ?? ''
if (pageId === '') process.exit(0)

const layer = Layer.mergeAll(
  Layer.succeed(NotionConfig, {
    authToken: Redacted.make(process.env.NOTION_API_TOKEN ?? ''),
    retryEnabled: true,
    maxRetries: 5,
    retryBaseDelay: 1000,
  }),
  FetchHttpClient.layer,
)

await Effect.runPromise(
  NotionPages.archive({ pageId }).pipe(
    Effect.asVoid,
    Effect.catchAll(() => Effect.void),
    Effect.provide(layer),
  ),
)
