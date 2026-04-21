import * as path from 'node:path'

import { FetchHttpClient, type HttpClient } from '@effect/platform'
import { Chunk, Effect, Layer, Redacted, Stream } from 'effect'

import { NotionBlocks, NotionConfig, NotionPages } from '@overeng/notion-effect-client'

import * as Host from '../components/mod.ts'
import { FsCache } from '../cache/mod.ts'
import { sync } from '../renderer/mod.ts'
import { notionPageDemos } from './page-demos.tsx'

const DEFAULT_PARENT_PAGE_ID = '349f141b18dc8002ad6debd74e7eec76'
const CACHE_DIR = path.join(process.cwd(), 'tmp', 'notion-demo-cache')

type Env = NotionConfig | HttpClient.HttpClient

const titleProp = (title: string) => ({
  title: {
    title: [{ type: 'text' as const, text: { content: title } }],
  },
})

const envOrThrow = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const pageIdFromInput = (value: string): string => {
  const trimmed = value.trim()
  const match = trimmed.match(/([0-9a-f]{32})/i)
  if (match) return match[1]!
  return trimmed.replace(/-/g, '')
}

const childPageTitle = (block: unknown): string | undefined => {
  const candidate = block as { type?: string; child_page?: { title?: string } }
  return candidate.type === 'child_page' ? candidate.child_page?.title : undefined
}

const listChildPages = (parentPageId: string): Effect.Effect<
  ReadonlyMap<string, string>,
  unknown,
  Env
> =>
  Effect.gen(function* () {
    const blocks = yield* Stream.runCollect(
      NotionBlocks.retrieveChildrenStream({ blockId: parentPageId }),
    )
    const pages = new Map<string, string>()
    for (const block of Chunk.toReadonlyArray(blocks)) {
      const title = childPageTitle(block)
      if (title !== undefined) {
        const id = (block as { id: string }).id
        pages.set(title, id)
      }
    }
    return pages
  })

const ensureChildPage = (
  parentPageId: string,
  title: string,
  existing: ReadonlyMap<string, string>,
): Effect.Effect<string, unknown, Env> =>
  Effect.gen(function* () {
    const found = existing.get(title)
    if (found !== undefined) return found
    const created = yield* NotionPages.create({
      parent: { type: 'page_id', page_id: parentPageId },
      properties: titleProp(title),
    })
    const pageId = (created as { id?: string }).id
    if (pageId === undefined) throw new Error(`create page returned no id for ${title}`)
    return pageId
  })

const syncChildPage = (
  slug: string,
  pageId: string,
): Effect.Effect<void, unknown, Env> =>
  sync(
    notionPageDemos.find((demo) => demo.slug === slug)!.render(Host),
    {
      pageId,
      cache: FsCache.make(path.join(CACHE_DIR, `${slug}.${pageId}.json`)),
    },
  ).pipe(Effect.asVoid)

const program = (parentPageId: string): Effect.Effect<void, unknown, Env> =>
  Effect.gen(function* () {
    const existing = yield* listChildPages(parentPageId)
    for (const demo of notionPageDemos) {
      const pageId = yield* ensureChildPage(parentPageId, demo.title, existing)
      yield* syncChildPage(demo.slug, pageId)
      // eslint-disable-next-line no-console
      console.log(`synced ${demo.slug} -> ${pageId}`)
    }
  })

const main = async () => {
  const notionToken = envOrThrow('NOTION_TOKEN')
  const rawParent = process.argv[2] ?? process.env.NOTION_DEMO_PARENT_PAGE_ID ?? DEFAULT_PARENT_PAGE_ID
  const parentPageId = pageIdFromInput(rawParent)

  const layer = Layer.mergeAll(
    Layer.succeed(NotionConfig, {
      authToken: Redacted.make(notionToken),
      retryEnabled: true,
      maxRetries: 5,
      retryBaseDelay: 1000,
    }),
    FetchHttpClient.layer,
  )

  await Effect.runPromise(program(parentPageId).pipe(Effect.provide(layer)))
}

await main()
