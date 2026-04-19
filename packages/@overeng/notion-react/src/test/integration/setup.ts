import { FetchHttpClient, type HttpClient } from '@effect/platform'
import { Effect, Layer, Redacted } from 'effect'

import { NotionBlocks, NotionConfig, NotionPages } from '@overeng/notion-effect-client'

/** Skip integration tests when the Notion API token is absent. */
export const SKIP_INTEGRATION = !process.env.NOTION_TOKEN || !process.env.NOTION_TEST_PARENT_PAGE_ID

/** Parent page under which each test creates a short-lived scratch child page. */
export const TEST_PARENT_PAGE_ID = process.env.NOTION_TEST_PARENT_PAGE_ID ?? ''

/** Live `NotionConfig` layer driven by `NOTION_TOKEN`. */
export const NotionConfigLive = Layer.succeed(NotionConfig, {
  authToken: Redacted.make(process.env.NOTION_TOKEN ?? ''),
  retryEnabled: true,
  maxRetries: 3,
  retryBaseDelay: 1000,
})

/** Full Effect layer for integration tests: live config + fetch HTTP. */
export const IntegrationTestLayer: Layer.Layer<NotionConfig | HttpClient.HttpClient> =
  Layer.mergeAll(NotionConfigLive, FetchHttpClient.layer)

/** Alias matching the task spec wording. */
export const NotionLayer = IntegrationTestLayer

/**
 * Create a fresh scratch child page under `TEST_PARENT_PAGE_ID` and return
 * its id. The page has no content and a timestamped title so parallel runs
 * don't collide visually.
 */
export const createScratchPage = (
  label: string,
): Effect.Effect<string, unknown, NotionConfig | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const res = yield* NotionPages.create({
      parent: { type: 'page_id', page_id: TEST_PARENT_PAGE_ID },
      properties: {
        title: {
          title: [{ type: 'text', text: { content: `notion-react test: ${label}` } }],
        },
      },
    })
    const id = (res as { id?: string }).id
    if (id === undefined) throw new Error('createScratchPage: Notion did not return an id')
    return id
  })

/** Archive (soft-delete) a scratch page created by `createScratchPage`. */
export const archiveScratchPage = (
  pageId: string,
): Effect.Effect<void, unknown, NotionConfig | HttpClient.HttpClient> =>
  NotionPages.archive({ pageId }).pipe(Effect.asVoid)

/**
 * Lightweight representation of a block tree fetched from Notion. Mirrors
 * what callers typically assert on — block type + a minimal payload shape —
 * without depending on the raw API shape.
 */
export interface ReadBlockNode {
  readonly id: string
  readonly type: string
  /** Raw per-type payload (e.g. `{rich_text: [...]}` for `paragraph`). */
  readonly payload: Record<string, unknown>
  readonly children: readonly ReadBlockNode[]
}

/**
 * Recursively fetch a page's block tree. Intended for assertions — not a
 * production read path. Stops at a conservative depth to avoid runaway
 * recursion on unexpected fixtures.
 */
export const readPageTree = (
  pageId: string,
  maxDepth = 8,
): Effect.Effect<readonly ReadBlockNode[], unknown, NotionConfig | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    if (maxDepth < 0) return [] as readonly ReadBlockNode[]
    const res = yield* NotionBlocks.retrieveChildren({ blockId: pageId })
    const out: ReadBlockNode[] = []
    for (const raw of res.results) {
      const block = raw as {
        id: string
        type: string
        has_children?: boolean
        [k: string]: unknown
      }
      const payload = (block[block.type] as Record<string, unknown>) ?? {}
      const children = block.has_children ? yield* readPageTree(block.id, maxDepth - 1) : []
      out.push({ id: block.id, type: block.type, payload, children })
    }
    return out
  })
