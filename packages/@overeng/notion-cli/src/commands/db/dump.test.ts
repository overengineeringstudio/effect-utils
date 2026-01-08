/**
 * Integration tests for db dump command
 */

import { describe, it } from '@effect/vitest'
import { Effect, Option, Stream } from 'effect'
import { expect } from 'vitest'

import { NotionBlocks, NotionDatabases } from '@overeng/notion-effect-client'
import {
  IntegrationTestLayer,
  SKIP_INTEGRATION,
  TEST_IDS,
} from '@overeng/notion-effect-client/test'

import {
  decodeDumpPage,
  type DumpBlockWithDepth,
  DumpPage,
  encodeDumpPage,
} from '../../dump/schema.ts'

describe.skipIf(SKIP_INTEGRATION)('db dump - content fetching', () => {
  it.effect(
    'should fetch page content blocks using retrieveAllNested',
    () =>
      Effect.gen(function* () {
        const blocksStream = NotionBlocks.retrieveAllNested({
          blockId: TEST_IDS.deepNestingPage,
          concurrency: 3,
        })

        const blocks = yield* Stream.runCollect(blocksStream).pipe(Effect.map((chunk) => [...chunk]))

        expect(blocks.length).toBeGreaterThan(0)

        // Verify block structure
        for (const block of blocks) {
          expect(block.block).toHaveProperty('id')
          expect(block.block).toHaveProperty('type')
          expect(typeof block.depth).toBe('number')
          expect(block.depth).toBeGreaterThanOrEqual(0)
        }

        // Verify we have some nested blocks (depth > 0)
        const nestedBlocks = blocks.filter((b) => b.depth > 0)
        expect(nestedBlocks.length).toBeGreaterThan(0)
      }).pipe(Effect.provide(IntegrationTestLayer)),
    { timeout: 60000 },
  )

  it.effect(
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

        // All blocks with maxDepth=0 should have depth 0
        for (const block of blocksDepth0) {
          expect(block.depth).toBe(0)
        }

        // With maxDepth=1, we should have blocks at depth 0 and 1
        const maxDepthFound = Math.max(...blocksDepth1.map((b) => b.depth))
        expect(maxDepthFound).toBeLessThanOrEqual(1)

        // Should have more blocks when going deeper
        expect(blocksDepth1.length).toBeGreaterThanOrEqual(blocksDepth0.length)
      }).pipe(Effect.provide(IntegrationTestLayer)),
    { timeout: 60000 },
  )

  it.effect(
    'should convert BlockWithDepth to DumpBlockWithDepth format',
    () =>
      Effect.gen(function* () {
        const blocksStream = NotionBlocks.retrieveAllNested({
          blockId: TEST_IDS.pageWithBlocks,
          maxDepth: 2,
        })

        const blocks = yield* Stream.runCollect(blocksStream).pipe(Effect.map((chunk) => [...chunk]))

        // Convert to dump format
        const dumpBlocks: DumpBlockWithDepth[] = blocks.map((b) => ({
          block: b.block as Record<string, unknown>,
          depth: b.depth,
          parentId: b.parentId,
        }))

        // Verify we can create a DumpPage with the content
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

        // Verify block types are preserved
        for (const block of dumpPage.content!) {
          expect(block.block).toHaveProperty('type')
          expect(typeof block.depth).toBe('number')
        }
      }).pipe(Effect.provide(IntegrationTestLayer)),
    { timeout: 60000 },
  )
})

describe.skipIf(SKIP_INTEGRATION)('db dump - database queries', () => {
  it.effect(
    'should query database and fetch pages',
    () =>
      Effect.gen(function* () {
        const result = yield* NotionDatabases.query({
          databaseId: TEST_IDS.dumpDatabase,
          pageSize: 5,
        })

        expect(result.results.length).toBeGreaterThan(0)
        expect(result.results.length).toBeLessThanOrEqual(5)

        // Verify page structure
        for (const page of result.results) {
          expect(page).toHaveProperty('id')
          expect(page).toHaveProperty('properties')
          expect(page).toHaveProperty('created_time')
          expect(page).toHaveProperty('last_edited_time')
        }
      }).pipe(Effect.provide(IntegrationTestLayer)),
    { timeout: 30000 },
  )

  it.effect(
    'should handle pagination correctly',
    () =>
      Effect.gen(function* () {
        const allPages: string[] = []
        let startCursor: string | undefined

        // Fetch pages in batches of 3 from large database
        while (true) {
          const result = yield* NotionDatabases.query({
            databaseId: TEST_IDS.largeDatabase,
            pageSize: 3,
            ...(startCursor ? { startCursor } : {}),
          })

          for (const page of result.results) {
            allPages.push(page.id)
          }

          if (!result.hasMore) break
          if (Option.isNone(result.nextCursor)) break
          startCursor = result.nextCursor.value
        }

        // Should have fetched all pages (60 in the large database)
        expect(allPages.length).toBeGreaterThanOrEqual(10)

        // Verify no duplicates
        const uniquePages = new Set(allPages)
        expect(uniquePages.size).toBe(allPages.length)
      }).pipe(Effect.provide(IntegrationTestLayer)),
    { timeout: 120000 },
  )
})

describe.skipIf(SKIP_INTEGRATION)('db dump - DumpPage schema', () => {
  it.effect(
    'should encode and decode DumpPage with content',
    () =>
      Effect.gen(function* () {
        const blocksStream = NotionBlocks.retrieveAllNested({
          blockId: TEST_IDS.pageWithBlocks,
          maxDepth: 1,
        })

        const blocks = yield* Stream.runCollect(blocksStream).pipe(Effect.map((chunk) => [...chunk]))

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

        // Encode to JSON string (NDJSON line)
        const encoded = encodeDumpPage(dumpPage)

        expect(typeof encoded).toBe('string')
        expect(encoded.length).toBeGreaterThan(0)

        // Decode back
        const decoded = decodeDumpPage(encoded)

        expect(decoded.id).toBe(dumpPage.id)
        expect(decoded.content).toBeDefined()
        expect(decoded.content!.length).toBe(dumpPage.content!.length)
      }).pipe(Effect.provide(IntegrationTestLayer)),
    { timeout: 60000 },
  )

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
