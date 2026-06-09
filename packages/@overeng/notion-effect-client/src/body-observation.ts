import { Effect } from 'effect'

import {
  classifyBodyCompleteness,
  type BlockInventory,
  type BlockInventoryEntry,
  type BodyCompleteness,
} from '@overeng/notion-core'
import type { PageMarkdown } from '@overeng/notion-effect-schema'

import { NotionBlocks, type BlockTree } from './blocks.ts'
import { NotionMarkdown } from './markdown.ts'
import { NotionPages } from './pages.ts'

export interface NotionBodyObservation {
  readonly pageId: string
  readonly markdown: {
    readonly markdown: string
    readonly truncated: boolean
    readonly unknownBlockIds: readonly string[]
  }
  readonly inventory: BlockInventory
  readonly completeness: BodyCompleteness
}

const inventoryEntries = (tree: BlockTree): readonly BlockInventoryEntry[] => {
  const entries: BlockInventoryEntry[] = []
  const visit = (nodes: BlockTree): void => {
    for (const node of nodes) {
      entries.push({
        id: node.block.id,
        type: node.block.type,
        hasChildren: node.block.has_children,
        inTrash: node.block.in_trash,
      })
      visit(node.children)
    }
  }
  visit(tree)
  return entries
}

export const observeFromSnapshots = Effect.fn('NotionBody.observeFromSnapshots')(function* (opts: {
  readonly pageId: string
  readonly markdown: PageMarkdown
  readonly tree: BlockTree
}) {
  const renderedMarkdown = yield* NotionMarkdown.treeToMarkdown({ tree: opts.tree })
  const markdown = {
    markdown: opts.markdown.markdown,
    truncated: opts.markdown.truncated,
    unknownBlockIds: opts.markdown.unknown_block_ids,
  }
  const inventory = {
    entries: inventoryEntries(opts.tree),
    renderedMarkdown,
  }
  return {
    pageId: opts.pageId,
    markdown,
    inventory,
    completeness: classifyBodyCompleteness({ markdown, inventory }),
  }
})

export const observe = Effect.fn('NotionBody.observe')(function* (opts: {
  readonly pageId: string
}) {
  const markdown = yield* NotionPages.getMarkdown({ pageId: opts.pageId })
  const tree = yield* NotionBlocks.retrieveAsTree({ blockId: opts.pageId })
  return yield* observeFromSnapshots({ pageId: opts.pageId, markdown, tree })
})

export const NotionBody = {
  observe,
  observeFromSnapshots,
} as const
