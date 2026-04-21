import * as path from 'node:path'

import { FetchHttpClient, type HttpClient } from '@effect/platform'
import { Chunk, Effect, Layer, Redacted, Stream } from 'effect'

import { NotionBlocks, NotionConfig, NotionPages } from '@overeng/notion-effect-client'

import { FsCache } from '../cache/mod.ts'
import * as Host from '../components/mod.ts'
import { sync } from '../renderer/mod.ts'
import type { DemoContext } from './page-demos.tsx'
import {
  storybookChildPagesByParent,
  storybookRootPages,
  storybookSyncPages,
  type StorybookSyncPage,
} from './storybook-sync-catalog.tsx'

const DEFAULT_PARENT_PAGE_ID = '349f141b18dc8002ad6debd74e7eec76'
const CACHE_DIR = path.join(process.cwd(), 'tmp', 'notion-demo-cache')

type Env = NotionConfig | HttpClient.HttpClient

type ListedChildPage = {
  readonly id: string
  readonly title: string
}

const TEMP_REORDER_PAGE_PREFIX = 'notion-react reorder tmp @ '

const compatibilityAliases = {
  'basic-blocks': 'demo-01-basic-blocks',
  'code-blocks': 'demo-04-code-blocks',
  'coverage-gaps': 'demo-10-placeholders',
  'features-index': 'demo-00-features-index',
  'launch-overview': 'pages-launch-overview',
  'links-and-navigation': 'demo-07-links',
  'lists-and-todos': 'demo-02-lists',
  'math-and-equations': 'demo-08-math-equations',
  'media-and-layout': 'category-media-layout',
  'team-update': 'pages-team-update',
  'tradeoffs-section': 'pages-tradeoffs-section',
} as const

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

const isLegacyProbePage = (entry: ListedChildPage): boolean =>
  entry.title.startsWith('notion-react child_page probe @ ')

const listChildPages = (
  parentPageId: string,
): Effect.Effect<readonly ListedChildPage[], unknown, Env> =>
  Effect.gen(function* () {
    const blocks = yield* Stream.runCollect(
      NotionBlocks.retrieveChildrenStream({ blockId: parentPageId }),
    )
    return Chunk.toReadonlyArray(blocks)
      .map((block) => {
        const title = childPageTitle(block)
        return title === undefined
          ? undefined
          : ({
              id: (block as { id: string }).id,
              title,
            } satisfies ListedChildPage)
      })
      .filter((entry): entry is ListedChildPage => entry !== undefined)
  })

const renamePageIfNeeded = (
  pageId: string,
  currentTitle: string,
  nextTitle: string,
): Effect.Effect<void, unknown, Env> =>
  currentTitle === nextTitle
    ? Effect.void
    : NotionPages.update({ pageId, properties: titleProp(nextTitle) }).pipe(Effect.asVoid)

const createPage = (parentPageId: string, title: string): Effect.Effect<string, unknown, Env> =>
  Effect.gen(function* () {
    const created = yield* NotionPages.create({
      parent: { type: 'page_id', page_id: parentPageId },
      properties: titleProp(title),
    })
    return created.id
  })

const movePage = (pageId: string, parentPageId: string): Effect.Effect<void, unknown, Env> =>
  NotionPages.move({
    pageId,
    parent: { type: 'page_id', page_id: parentPageId },
  }).pipe(Effect.asVoid)

const reorderManagedChildPages = (
  parentTitle: string,
  parentPageId: string,
  orderedEntries: readonly StorybookSyncPage[],
  pageIdsBySlug: ReadonlyMap<string, string>,
): Effect.Effect<void, unknown, Env> =>
  Effect.gen(function* () {
    if (orderedEntries.length <= 1) return

    const currentChildren = yield* listChildPages(parentPageId)
    const desiredChildren = orderedEntries.map((entry) => {
      const pageId = pageIdsBySlug.get(entry.slug)
      if (pageId === undefined) {
        throw new Error(`missing page id for reorder target ${entry.slug}`)
      }
      return {
        id: pageId,
        title: entry.title,
      } satisfies ListedChildPage
    })
    const desiredIds = new Set(desiredChildren.map((entry) => entry.id))
    const unexpectedChildren = currentChildren.filter(
      (entry) => !desiredIds.has(entry.id) && !isLegacyProbePage(entry),
    )

    if (unexpectedChildren.length > 0) {
      throw new Error(
        `cannot reorder ${parentTitle}; found unexpected child pages: ${unexpectedChildren.map((entry) => entry.title).join(', ')}`,
      )
    }

    const currentManagedIds = currentChildren
      .filter((entry) => desiredIds.has(entry.id))
      .map((entry) => entry.id)
    const desiredManagedIds = desiredChildren.map((entry) => entry.id)

    if (
      currentManagedIds.length === desiredManagedIds.length &&
      currentManagedIds.every((pageId, index) => pageId === desiredManagedIds[index])
    ) {
      return
    }

    const tempPageId = yield* createPage(
      parentPageId,
      `${TEMP_REORDER_PAGE_PREFIX}${new Date().toISOString()}`,
    )

    yield* Effect.forEach(currentManagedIds, (pageId) => movePage(pageId, tempPageId), {
      concurrency: 1,
      discard: true,
    }).pipe(
      Effect.zipRight(
        Effect.forEach(desiredManagedIds, (pageId) => movePage(pageId, parentPageId), {
          concurrency: 1,
          discard: true,
        }),
      ),
      Effect.ensuring(NotionPages.archive({ pageId: tempPageId }).pipe(Effect.asVoid)),
    )
  })

const consumeMatch = (
  entry: StorybookSyncPage,
  from: Map<string, ListedChildPage>,
): ListedChildPage | undefined => {
  const exact = from.get(entry.title)
  if (exact !== undefined) {
    from.delete(entry.title)
    return exact
  }
  for (const alias of entry.aliases ?? []) {
    const matched = from.get(alias)
    if (matched !== undefined) {
      from.delete(alias)
      return matched
    }
  }
  return undefined
}

const ensurePage = (
  parentPageId: string,
  entry: StorybookSyncPage,
  currentChildren: Map<string, ListedChildPage>,
  legacyRootChildren: Map<string, ListedChildPage>,
): Effect.Effect<string, unknown, Env> =>
  Effect.gen(function* () {
    const current = consumeMatch(entry, currentChildren)
    if (current !== undefined) {
      yield* renamePageIfNeeded(current.id, current.title, entry.title)
      return current.id
    }

    const legacy = consumeMatch(entry, legacyRootChildren)
    if (legacy !== undefined) {
      yield* movePage(legacy.id, parentPageId)
      yield* renamePageIfNeeded(legacy.id, legacy.title, entry.title)
      return legacy.id
    }

    return yield* createPage(parentPageId, entry.title)
  })

const syncPageContent = (
  demoContext: DemoContext,
  entry: StorybookSyncPage,
  pageId: string,
): Effect.Effect<void, unknown, Env> =>
  entry.render === undefined
    ? Effect.void
    : sync(entry.render(Host, demoContext), {
        pageId,
        cache: FsCache.make(path.join(CACHE_DIR, `${entry.slug}.${pageId}.json`)),
      }).pipe(Effect.asVoid)

const cleanupLegacyProbePages = (
  legacyRootChildren: Map<string, ListedChildPage>,
): Effect.Effect<void, unknown, Env> =>
  Effect.forEach(
    [...legacyRootChildren.values()].filter(isLegacyProbePage),
    (entry) => NotionPages.archive({ pageId: entry.id }).pipe(Effect.asVoid),
    { concurrency: 1, discard: true },
  )

const program = (rootPageId: string): Effect.Effect<void, unknown, Env> =>
  Effect.gen(function* () {
    const rootChildren = yield* listChildPages(rootPageId)
    const legacyRootChildren = new Map(rootChildren.map((entry) => [entry.title, entry]))
    const pageIdsBySlug = new Map<string, string>()

    for (const entry of storybookRootPages) {
      const pageId = yield* ensurePage(rootPageId, entry, legacyRootChildren, legacyRootChildren)
      pageIdsBySlug.set(entry.slug, pageId)
    }

    yield* reorderManagedChildPages('root demo page', rootPageId, storybookRootPages, pageIdsBySlug)

    for (const parent of storybookRootPages) {
      const parentId = pageIdsBySlug.get(parent.slug)!
      const currentChildren = new Map(
        (yield* listChildPages(parentId)).map((entry) => [entry.title, entry] as const),
      )
      for (const entry of storybookChildPagesByParent.get(parent.slug) ?? []) {
        const pageId = yield* ensurePage(parentId, entry, currentChildren, legacyRootChildren)
        pageIdsBySlug.set(entry.slug, pageId)
      }

      yield* reorderManagedChildPages(
        parent.title,
        parentId,
        storybookChildPagesByParent.get(parent.slug) ?? [],
        pageIdsBySlug,
      )
    }

    for (const [legacySlug, canonicalSlug] of Object.entries(compatibilityAliases)) {
      const pageId = pageIdsBySlug.get(canonicalSlug)
      if (pageId !== undefined) pageIdsBySlug.set(legacySlug, pageId)
    }

    const demoContext: DemoContext = {
      parentPageId: rootPageId,
      pageIdsBySlug,
    }

    for (const entry of storybookSyncPages) {
      const pageId = pageIdsBySlug.get(entry.slug)
      if (pageId === undefined) continue
      yield* syncPageContent(demoContext, entry, pageId)
      // eslint-disable-next-line no-console
      console.log(`synced ${entry.slug} -> ${pageId}`)
    }

    yield* cleanupLegacyProbePages(legacyRootChildren)
  })

const main = async () => {
  const notionToken = envOrThrow('NOTION_TOKEN')
  const rawParent =
    process.argv[2] ?? process.env.NOTION_DEMO_PARENT_PAGE_ID ?? DEFAULT_PARENT_PAGE_ID
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
