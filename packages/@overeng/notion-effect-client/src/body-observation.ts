import type { HttpClient } from '@effect/platform'
import { Effect, Schema } from 'effect'

import {
  classifyBodyCompleteness,
  type BlockInventory,
  type BlockInventoryEntry,
  type BodyCompleteness,
} from '@overeng/notion-core'
import type { PageMarkdown } from '@overeng/notion-effect-schema'

import { NotionBlocks, type BlockTree } from './blocks.ts'
import type { NotionConfig } from './config.ts'
import type { NotionApiError } from './error.ts'
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

/** Raised when a live body observation cannot find a stable page metadata window. */
export class NotionBodyObservationChangedError extends Schema.TaggedError<NotionBodyObservationChangedError>()(
  'NotionBodyObservationChangedError',
  {
    pageId: Schema.String,
    attempts: Schema.Int,
    beforeLastEditedTime: Schema.String,
    afterLastEditedTime: Schema.String,
    message: Schema.String,
  },
) {}

const NOTION_BODY_OBSERVATION_ATTEMPTS = 3

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
  return yield* observeStable({ pageId: opts.pageId, attempt: 0 })
})

const observeStable = (opts: {
  readonly pageId: string
  readonly attempt: number
}): Effect.Effect<
  NotionBodyObservation,
  NotionApiError | NotionBodyObservationChangedError,
  NotionConfig | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const before = yield* NotionPages.retrieve({ pageId: opts.pageId })
    const markdown = yield* NotionPages.getMarkdown({ pageId: opts.pageId })
    const tree = yield* NotionBlocks.retrieveAsTree({ blockId: opts.pageId })
    const after = yield* NotionPages.retrieve({ pageId: opts.pageId })

    if (before.last_edited_time === after.last_edited_time) {
      return yield* observeFromSnapshots({ pageId: opts.pageId, markdown, tree })
    }

    if (opts.attempt + 1 < NOTION_BODY_OBSERVATION_ATTEMPTS) {
      return yield* observeStable({ pageId: opts.pageId, attempt: opts.attempt + 1 })
    }

    return yield* new NotionBodyObservationChangedError({
      pageId: opts.pageId,
      attempts: NOTION_BODY_OBSERVATION_ATTEMPTS,
      beforeLastEditedTime: before.last_edited_time,
      afterLastEditedTime: after.last_edited_time,
      message: `Notion page body changed while observing page ${opts.pageId}; all ${NOTION_BODY_OBSERVATION_ATTEMPTS} observation attempts were unstable.`,
    })
  })

export const NotionBody = {
  observe,
  observeFromSnapshots,
} as const
