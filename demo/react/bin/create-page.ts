/**
 * BACKSTAGE helper. Creates one empty Notion page under $DEMO_PARENT_PAGE and
 * prints its id to stdout. Used by setup.sh / reset.sh — never run on camera.
 */
import { FetchHttpClient } from '@effect/platform'
import { Effect, Layer, Redacted } from 'effect'

import { NotionConfig, NotionPages } from '@overeng/notion-effect-client'

const parent = process.env.DEMO_PARENT_PAGE ?? ''
if (parent === '') throw new Error('DEMO_PARENT_PAGE is not set')

const layer = Layer.mergeAll(
  Layer.succeed(NotionConfig, {
    authToken: Redacted.make(process.env.NOTION_API_TOKEN ?? ''),
    retryEnabled: true,
    maxRetries: 5,
    retryBaseDelay: 1000,
  }),
  FetchHttpClient.layer,
)

const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')

const program = NotionPages.create({
  parent: { type: 'page_id', page_id: parent },
  properties: {
    title: { title: [{ type: 'text', text: { content: `Q2 Launch Plan — react demo (${stamp})` } }] },
  },
  icon: { type: 'emoji', emoji: '🚀' },
}).pipe(Effect.map((p) => (p as { id: string }).id))

const id = await Effect.runPromise(program.pipe(Effect.provide(layer)))
process.stdout.write(id)
