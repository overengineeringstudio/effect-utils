import { HttpClient } from '@effect/platform'
import { Effect, Layer } from 'effect'

import {
  NotionBlocks,
  NotionConfig,
  NotionPages,
  type NmdStorage,
} from '@overeng/notion-effect-client'
import type { Page } from '@overeng/notion-effect-schema'
import type { Block } from '@overeng/notion-effect-schema'

import { canonicalizeMarkdown } from './hash.ts'
import { NotionMdGateway, type RemotePageSnapshot } from './model.ts'

const titleFromProperties = (properties: Record<string, unknown>): string => {
  for (const property of Object.values(properties)) {
    if (typeof property !== 'object' || property === null || 'type' in property === false) {
      continue
    }

    const typed = property as {
      readonly type?: unknown
      readonly title?: readonly { readonly plain_text?: unknown }[]
    }

    if (typed.type === 'title' && Array.isArray(typed.title) === true) {
      return typed.title
        .map((part) => (typeof part.plain_text === 'string' ? part.plain_text : ''))
        .join('')
    }
  }

  return 'Untitled'
}

const toRemotePage = (page: Page): RemotePageSnapshot => ({
  id: page.id,
  title: titleFromProperties(page.properties),
  url: page.url,
  parent: page.parent,
  icon: page.icon,
  cover: page.cover,
  in_trash: page.in_trash,
  is_locked: page.is_locked ?? false,
  last_edited_time: page.last_edited_time,
  properties: page.properties,
})

const blockPayload = (block: Block): unknown => {
  const value = block[block.type]
  return value === undefined ? {} : value
}

const storageFromUnknownBlocks = (
  blocks: readonly Block[],
  placeholders: readonly string[],
): NmdStorage => ({
  _tag: 'self_contained',
  unsupported_blocks: blocks.map((block, index) => ({
    _tag: 'unsupported_block',
    block_id: block.id,
    block_type: block.type,
    placeholder: placeholders[index] ?? `<unknown alt="${block.type}"/>`,
    snapshot: {
      object: 'block',
      id: block.id,
      type: block.type,
      has_children: block.has_children,
      in_trash: block.in_trash,
      parent: block.parent,
      created_time: block.created_time,
      last_edited_time: block.last_edited_time,
      payload: blockPayload(block),
    },
  })),
  files: [],
  comments: [],
})

const unknownPlaceholders = (markdown: string): readonly string[] =>
  [...markdown.matchAll(/<unknown\b[^>]*\/>/giu)].map((match) => match[0])

export const NotionMdGatewayLive = Layer.effect(
  NotionMdGateway,
  Effect.gen(function* () {
    const config = yield* NotionConfig
    const client = yield* HttpClient.HttpClient
    const provideHttp = <A, E>(
      effect: Effect.Effect<A, E, NotionConfig | HttpClient.HttpClient>,
    ): Effect.Effect<A, E> =>
      effect.pipe(
        Effect.provideService(NotionConfig, config),
        Effect.provideService(HttpClient.HttpClient, client),
      )

    return {
      pullPage: ({ pageId }) =>
        Effect.gen(function* () {
          const page = yield* provideHttp(NotionPages.retrieve({ pageId }))
          const markdown = yield* provideHttp(NotionPages.getMarkdown({ pageId }))
          const unknownBlocks = yield* Effect.forEach(markdown.unknown_block_ids, (blockId) =>
            provideHttp(NotionBlocks.retrieve({ blockId })),
          )
          const remoteMarkdown = {
            markdown: canonicalizeMarkdown(markdown.markdown),
            truncated: markdown.truncated,
            unknown_block_ids: markdown.unknown_block_ids,
          }

          return unknownBlocks.length === 0
            ? {
                page: toRemotePage(page),
                markdown: remoteMarkdown,
              }
            : {
                page: toRemotePage(page),
                markdown: remoteMarkdown,
                storage: storageFromUnknownBlocks(
                  unknownBlocks,
                  unknownPlaceholders(markdown.markdown),
                ),
              }
        }),
      updateMarkdown: ({ pageId, markdown, allowDeletingContent }) =>
        provideHttp(
          NotionPages.updateMarkdown({
            pageId,
            type: 'replace_content',
            new_str: canonicalizeMarkdown(markdown),
            allow_deleting_content: allowDeletingContent,
          }),
        ).pipe(
          Effect.map((markdownResult) => ({
            markdown: {
              markdown: canonicalizeMarkdown(markdownResult.markdown),
              truncated: markdownResult.truncated,
              unknown_block_ids: markdownResult.unknown_block_ids,
            },
          })),
        ),
    }
  }),
)
