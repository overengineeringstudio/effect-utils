import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FetchHttpClient, type HttpClient } from '@effect/platform'
import { Effect, Layer, Redacted } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  NotionBlocks,
  type NotionConfig,
  NotionConfigLive,
  NotionPages,
} from '@overeng/notion-effect-client'

import { parseNmdFile, renderNmdFile } from './frontmatter.ts'
import { NotionMdGatewayLive } from './live.ts'
import type { NotionMdGateway } from './model.ts'
import { pullPage, pushPage, statusPage } from './sync.ts'

const token = process.env.NOTION_TOKEN ?? process.env.NOTION_API_TOKEN
const testParentPageId = process.env.NOTION_MD_TEST_PARENT_PAGE_ID
const skipLive =
  token === undefined ||
  token.length === 0 ||
  testParentPageId === undefined ||
  testParentPageId.length === 0

const ConfigLayer = NotionConfigLive({
  authToken: Redacted.make(token ?? ''),
  retryEnabled: true,
  maxRetries: 5,
  retryBaseDelay: 1000,
})

const BaseLayer = Layer.mergeAll(ConfigLayer, FetchHttpClient.layer)
const TestLayer = Layer.mergeAll(BaseLayer, NotionMdGatewayLive.pipe(Layer.provide(BaseLayer)))

type LiveEnv = NotionMdGateway | NotionConfig | HttpClient.HttpClient

const runLive = <A, E>(effect: Effect.Effect<A, E, LiveEnv>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestLayer)) as Effect.Effect<A, E, never>)

const createScratchPage = (label: string) =>
  Effect.gen(function* () {
    const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
    const page = yield* NotionPages.create({
      parent: { type: 'page_id', page_id: testParentPageId ?? '' },
      properties: {
        title: {
          title: [
            {
              type: 'text',
              text: { content: `notion-md e2e: ${label} @ ${stamp}` },
            },
          ],
        },
      },
      markdown: '# Notion MD Live E2E\n\nInitial body',
    })

    return page.id
  })

const archiveScratchPage = (pageId: string) =>
  NotionPages.archive({ pageId }).pipe(
    Effect.asVoid,
    Effect.catchAll(() => Effect.void),
  )

const withScratchPage = async <A>(label: string, body: (pageId: string) => Promise<A>) => {
  const pageId = await runLive(createScratchPage(label))
  try {
    return await body(pageId)
  } finally {
    await runLive(archiveScratchPage(pageId))
  }
}

const withTempDir = async <A>(body: (dir: string) => Promise<A>) => {
  const dir = await mkdtemp(join(tmpdir(), 'notion-md-live-'))
  try {
    return await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe.skipIf(skipLive)('notion-md live integration', () => {
  it('pulls, statuses, pushes, and rejects stale overwrites against Notion', async () => {
    await withScratchPage('roundtrip-conflict', async (pageId) => {
      await withTempDir(async (dir) => {
        const path = join(dir, 'page.nmd')

        const pulled = await runLive(pullPage({ pageId, outPath: path }))
        const parsed = await runLive(
          Effect.promise(() => readFile(path, 'utf8')).pipe(
            Effect.flatMap((content) => parseNmdFile({ path, content })),
          ),
        )
        const cleanStatus = await runLive(statusPage({ path }))

        expect(pulled.pageId).toBe(pageId)
        expect(pulled.storage).toBe('self_contained')
        expect(parsed.frontmatter.notion_md.page_id).toBe(pageId)
        expect(parsed.body).toContain('Initial body')
        expect(cleanStatus.localChanged).toBe(false)
        expect(cleanStatus.remoteChanged).toBe(false)

        const firstContent = await readFile(path, 'utf8')
        await writeFile(path, firstContent.replace('Initial body', 'Local body'))

        const pushed = await runLive(pushPage({ path }))
        const afterPushStatus = await runLive(statusPage({ path }))
        const remoteAfterPush = await runLive(NotionPages.getMarkdown({ pageId }))

        expect(pushed.pushed).toBe(true)
        expect(afterPushStatus.localChanged).toBe(false)
        expect(afterPushStatus.remoteChanged).toBe(false)
        expect(remoteAfterPush.markdown).toContain('Local body')

        const secondContent = await readFile(path, 'utf8')
        await writeFile(path, secondContent.replace('Local body', 'Second local body'))
        await runLive(
          NotionPages.updateMarkdown({
            pageId,
            type: 'replace_content',
            new_str: '# Notion MD Live E2E\n\nRemote body',
            allow_deleting_content: true,
          }),
        )

        await expect(runLive(pushPage({ path }))).rejects.toThrow(
          'Remote page changed since the last clean pull',
        )
      })
    })
  })

  it('refuses to push over unresolved unknown blocks against Notion', async () => {
    await withScratchPage('unknown-block-guard', async (pageId) => {
      await runLive(
        NotionBlocks.append({
          blockId: pageId,
          children: [
            {
              type: 'bookmark',
              bookmark: { url: 'https://developers.notion.com/' },
            },
          ],
        }),
      )

      await withTempDir(async (dir) => {
        const path = join(dir, 'unknown.nmd')
        const pulled = await runLive(pullPage({ pageId, outPath: path }))
        const content = await readFile(path, 'utf8')
        await writeFile(path, content.replace('Initial body', 'Local body'))

        expect(pulled.storage).toBe('self_contained')
        await expect(runLive(pushPage({ path }))).rejects.toThrow(
          'Page contains unresolved unknown Notion blocks',
        )
      })
    })
  })

  it('pushes explicit title property edits against Notion', async () => {
    await withScratchPage('property-write', async (pageId) => {
      await withTempDir(async (dir) => {
        const path = join(dir, 'property.nmd')
        await runLive(pullPage({ pageId, outPath: path }))
        const parsed = await runLive(
          Effect.promise(() => readFile(path, 'utf8')).pipe(
            Effect.flatMap((content) => parseNmdFile({ path, content })),
          ),
        )
        const nextTitle = `notion-md property updated ${new Date().toISOString()}`
        await writeFile(
          path,
          renderNmdFile(
            {
              notion_md: {
                ...parsed.frontmatter.notion_md,
                properties: {
                  ...parsed.frontmatter.notion_md.properties,
                  title: { _tag: 'title', value: nextTitle },
                },
              },
            },
            parsed.body,
          ),
        )

        const pushed = await runLive(pushPage({ path }))
        const refreshed = await runLive(
          Effect.promise(() => readFile(path, 'utf8')).pipe(
            Effect.flatMap((content) => parseNmdFile({ path, content })),
          ),
        )

        expect(pushed.pushed).toBe(true)
        expect(refreshed.frontmatter.notion_md.page.title).toBe(nextTitle)
      })
    })
  })
})
