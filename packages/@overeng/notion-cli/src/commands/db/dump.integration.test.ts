import { Effect, Option, Stream } from 'effect'
import { afterAll, beforeAll, expect, it } from 'vitest'

import { NotionBlocks, NotionDatabases } from '@overeng/notion-effect-client'
import {
  IntegrationTestLayer,
  setupIntegrationFixtures,
  SKIP_FIXTURE_INTEGRATION,
  teardownIntegrationFixtures,
  TEST_IDS,
} from '@overeng/notion-effect-client/test'
import { Vitest } from '@overeng/utils-dev/node-vitest'

import {
  decodeDumpPage,
  type DumpBlockWithDepth,
  type DumpPage,
  encodeDumpPage,
} from '../../dump/schema.ts'

Vitest.describe.skipIf(SKIP_FIXTURE_INTEGRATION)('db dump integration', () => {
  beforeAll(setupIntegrationFixtures, 120_000)
  afterAll(teardownIntegrationFixtures, 60_000)

  Vitest.describe('content fetching', () => {
    Vitest.it.effect(
      'should fetch page content blocks using retrieveAllNested',
      () =>
        Effect.gen(function* () {
          const blocksStream = NotionBlocks.retrieveAllNested({
            blockId: TEST_IDS.deepNestingPage,
            concurrency: 3,
          })

          const blocks = yield* Stream.runCollect(blocksStream).pipe(
            Effect.map((chunk) => [...chunk]),
          )

          expect(blocks.length).toBeGreaterThan(0)

          for (const block of blocks) {
            expect(block.block).toHaveProperty('id')
            expect(block.block).toHaveProperty('type')
            expect(typeof block.depth).toBe('number')
            expect(block.depth).toBeGreaterThanOrEqual(0)
          }

          const nestedBlocks = blocks.filter((b) => b.depth > 0)
          expect(nestedBlocks.length).toBeGreaterThan(0)
        }).pipe(Effect.provide(IntegrationTestLayer)),
      { timeout: 60000 },
    )

    Vitest.it.effect(
      'should respect maxDepth option when fetching content',
      () =>
        Effect.gen(function* () {
          const blocksDepth1 = yield* NotionBlocks.retrieveAllNested({
            blockId: TEST_IDS.deepNestingPage,
            maxDepth: 1,
          }).pipe(
            Stream.runCollect,
            Effect.map((chunk) => [...chunk]),
          )

          const blocksDepth0 = yield* NotionBlocks.retrieveAllNested({
            blockId: TEST_IDS.deepNestingPage,
            maxDepth: 0,
          }).pipe(
            Stream.runCollect,
            Effect.map((chunk) => [...chunk]),
          )

          for (const block of blocksDepth0) {
            expect(block.depth).toBe(0)
          }

          const maxDepthFound = Math.max(...blocksDepth1.map((b) => b.depth))
          expect(maxDepthFound).toBeLessThanOrEqual(1)

          expect(blocksDepth1.length).toBeGreaterThanOrEqual(blocksDepth0.length)
        }).pipe(Effect.provide(IntegrationTestLayer)),
      { timeout: 60000 },
    )

    Vitest.it.effect(
      'should convert BlockWithDepth to DumpBlockWithDepth format',
      () =>
        Effect.gen(function* () {
          const blocksStream = NotionBlocks.retrieveAllNested({
            blockId: TEST_IDS.pageWithBlocks,
            maxDepth: 2,
          })

          const blocks = yield* Stream.runCollect(blocksStream).pipe(
            Effect.map((chunk) => [...chunk]),
          )

          const dumpBlocks: DumpBlockWithDepth[] = blocks.map((b) => ({
            block: b.block as Record<string, unknown>,
            depth: b.depth,
            parentId: b.parentId,
          }))

          const dumpPage: typeof DumpPage.Type = {
            id: TEST_IDS.pageWithBlocks,
            url: `https://notion.so/${TEST_IDS.pageWithBlocks.replace(/-/g, '')}`,
            createdTime: new Date().toISOString(),
            lastEditedTime: new Date().toISOString(),
            properties: {},
            content: dumpBlocks,
          }

          expect(dumpPage.content).toBeDefined()
          expect(dumpPage.content!.length).toBeGreaterThan(0)

          for (const block of dumpPage.content!) {
            expect(block.block).toHaveProperty('type')
            expect(typeof block.depth).toBe('number')
          }
        }).pipe(Effect.provide(IntegrationTestLayer)),
      { timeout: 60000 },
    )
  })

  Vitest.describe('database queries', () => {
    Vitest.it.effect(
      'should query database and fetch pages',
      () =>
        Effect.gen(function* () {
          const result = yield* NotionDatabases.query({
            dataSourceId: TEST_IDS.dumpDataSource,
            pageSize: 5,
          })

          expect(result.results.length).toBeGreaterThan(0)
          expect(result.results.length).toBeLessThanOrEqual(5)

          for (const page of result.results) {
            expect(page).toHaveProperty('id')
            expect(page).toHaveProperty('properties')
            expect(page).toHaveProperty('created_time')
            expect(page).toHaveProperty('last_edited_time')
          }
        }).pipe(Effect.provide(IntegrationTestLayer)),
      { timeout: 30000 },
    )

    Vitest.it.effect(
      'should handle pagination correctly',
      () =>
        Effect.gen(function* () {
          const allPages: string[] = []
          let startCursor: string | undefined

          while (true) {
            const result = yield* NotionDatabases.query({
              dataSourceId: TEST_IDS.largeDataSource,
              pageSize: 3,
              ...(startCursor !== undefined ? { startCursor } : {}),
            })

            for (const page of result.results) {
              allPages.push(page.id)
            }

            if (result.hasMore === false) break
            if (Option.isNone(result.nextCursor) === true) break
            startCursor = result.nextCursor.value
          }

          expect(allPages.length).toBeGreaterThanOrEqual(10)

          const uniquePages = new Set(allPages)
          expect(uniquePages.size).toBe(allPages.length)
        }).pipe(Effect.provide(IntegrationTestLayer)),
      { timeout: 120000 },
    )
  })

  Vitest.describe('DumpPage schema', () => {
    Vitest.it.effect(
      'should encode and decode DumpPage with content',
      () =>
        Effect.gen(function* () {
          const blocksStream = NotionBlocks.retrieveAllNested({
            blockId: TEST_IDS.pageWithBlocks,
            maxDepth: 1,
          })

          const blocks = yield* Stream.runCollect(blocksStream).pipe(
            Effect.map((chunk) => [...chunk]),
          )

          const dumpPage: typeof DumpPage.Type = {
            id: TEST_IDS.pageWithBlocks,
            url: `https://notion.so/${TEST_IDS.pageWithBlocks.replace(/-/g, '')}`,
            createdTime: '2024-01-01T00:00:00.000Z',
            lastEditedTime: '2024-01-15T12:00:00.000Z',
            properties: { Name: { type: 'title', title: [] } },
            content: blocks.map((b) => ({
              block: b.block as Record<string, unknown>,
              depth: b.depth,
              parentId: b.parentId,
            })),
          }

          const encoded = encodeDumpPage(dumpPage)

          expect(typeof encoded).toBe('string')
          expect(encoded.length).toBeGreaterThan(0)

          const decoded = decodeDumpPage(encoded)

          expect(decoded.id).toBe(dumpPage.id)
          expect(decoded.content).toBeDefined()
          expect(decoded.content!.length).toBe(dumpPage.content!.length)
        }).pipe(Effect.provide(IntegrationTestLayer)),
      { timeout: 60000 },
    )
  })
})

Vitest.describe('db dump - DumpPage schema', () => {
  it('should encode DumpPage without content', () => {
    const dumpPage: typeof DumpPage.Type = {
      id: 'test-page-id',
      url: 'https://notion.so/test',
      createdTime: '2024-01-01T00:00:00.000Z',
      lastEditedTime: '2024-01-15T12:00:00.000Z',
      properties: { Name: { type: 'title', title: [] } },
      content: undefined,
    }

    const encoded = encodeDumpPage(dumpPage)
    const decoded = decodeDumpPage(encoded)

    expect(decoded.id).toBe('test-page-id')
    expect(decoded.content).toBeUndefined()
  })
})
