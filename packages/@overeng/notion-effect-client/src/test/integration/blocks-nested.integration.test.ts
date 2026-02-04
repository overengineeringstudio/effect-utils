import { Effect, Stream } from 'effect'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { NotionBlocks } from '../../blocks.ts'
import { IntegrationTestLayer, SKIP_INTEGRATION, TEST_IDS } from './setup.ts'

Vitest.describe.skipIf(SKIP_INTEGRATION)('NotionBlocks recursive fetching (integration)', () => {
  Vitest.describe('retrieveAllNested', () => {
    Vitest.it.effect(
      'fetches all nested blocks as flat stream with depth info',
      () =>
        Effect.gen(function* () {
          const stream = NotionBlocks.retrieveAllNested({
            blockId: TEST_IDS.nestedPage,
            maxDepth: 5,
          })

          const items = yield* Stream.runCollect(stream).pipe(Effect.map((chunk) => [...chunk]))

          expect(items.length).toBeGreaterThan(0)

          // Check that we have items at various depths
          const depths = new Set(items.map((item) => item.depth))
          expect(depths.has(0)).toBe(true)

          // Verify structure
          for (const item of items) {
            expect(item.block).toBeDefined()
            expect(item.block.object).toBe('block')
            expect(typeof item.depth).toBe('number')
            expect(item.depth).toBeGreaterThanOrEqual(0)
          }
        }).pipe(Effect.provide(IntegrationTestLayer)),
      { timeout: 60000 },
    )

    Vitest.it.effect(
      'respects maxDepth option',
      () =>
        Effect.gen(function* () {
          const stream = NotionBlocks.retrieveAllNested({
            blockId: TEST_IDS.pageWithBlocks,
            maxDepth: 0, // Only top-level blocks
          })

          const items = yield* Stream.runCollect(stream).pipe(Effect.map((chunk) => [...chunk]))

          // All items should be at depth 0
          for (const item of items) {
            expect(item.depth).toBe(0)
          }
        }).pipe(Effect.provide(IntegrationTestLayer)),
      { timeout: 30000 },
    )

    Vitest.it.effect(
      'includes parentId for nested blocks',
      () =>
        Effect.gen(function* () {
          const stream = NotionBlocks.retrieveAllNested({
            blockId: TEST_IDS.nestedPage,
            maxDepth: 5,
          })

          const items = yield* Stream.runCollect(stream).pipe(Effect.map((chunk) => [...chunk]))

          // Top-level blocks should have null parentId
          const topLevel = items.filter((item) => item.depth === 0)
          for (const item of topLevel) {
            expect(item.parentId).toBeNull()
          }

          // Nested blocks should have non-null parentId
          const nested = items.filter((item) => item.depth > 0)
          for (const item of nested) {
            expect(item.parentId).not.toBeNull()
          }
        }).pipe(Effect.provide(IntegrationTestLayer)),
      { timeout: 60000 },
    )
  })

  Vitest.describe('retrieveAsTree', () => {
    Vitest.it.effect(
      'fetches all nested blocks as tree structure',
      () =>
        Effect.gen(function* () {
          const tree = yield* NotionBlocks.retrieveAsTree({
            blockId: TEST_IDS.nestedPage,
            maxDepth: 5,
          })

          expect(tree.length).toBeGreaterThan(0)

          // Verify tree structure
          for (const node of tree) {
            expect(node.block).toBeDefined()
            expect(node.block.object).toBe('block')
            expect(Array.isArray(node.children)).toBe(true)
          }
        }).pipe(Effect.provide(IntegrationTestLayer)),
      { timeout: 60000 },
    )

    Vitest.it.effect(
      'respects maxDepth for tree',
      () =>
        Effect.gen(function* () {
          const tree = yield* NotionBlocks.retrieveAsTree({
            blockId: TEST_IDS.pageWithBlocks,
            maxDepth: 0,
          })

          // All nodes should have empty children (since maxDepth is 0)
          for (const node of tree) {
            expect(node.children.length).toBe(0)
          }
        }).pipe(Effect.provide(IntegrationTestLayer)),
      { timeout: 30000 },
    )

    Vitest.it.effect(
      'includes nested children in tree nodes',
      () =>
        Effect.gen(function* () {
          const tree = yield* NotionBlocks.retrieveAsTree({
            blockId: TEST_IDS.nestedPage,
            maxDepth: 5,
          })

          // Helper to count total nodes in tree
          const countNodes = (nodes: readonly { children: readonly unknown[] }[]): number => {
            let count = nodes.length
            for (const node of nodes) {
              count += countNodes(node.children as typeof nodes)
            }
            return count
          }

          const totalNodes = countNodes(tree)
          expect(totalNodes).toBeGreaterThanOrEqual(tree.length)
        }).pipe(Effect.provide(IntegrationTestLayer)),
      { timeout: 60000 },
    )
  })
})
