import { HttpClient } from '@effect/platform'
import { Effect, Layer, Stream } from 'effect'

import {
  NotionBlocks,
  NotionConfig,
  NotionPages,
  type NmdStorage,
  type UpdateMarkdownOptions,
} from '@overeng/notion-effect-client'
import type { Page } from '@overeng/notion-effect-schema'
import type { Block } from '@overeng/notion-effect-schema'

import { canonicalizeBlockMarkdown, semanticEquivalent } from './canonical-markdown.ts'
import { NmdGatewayError } from './errors.ts'
import { normalizeMarkdownLineEndings } from './hash.ts'
import {
  type MarkdownUpdateCommand,
  NotionMdGateway,
  type RemoteChildPage,
  type RemotePageSnapshot,
} from './model.ts'

/*
 * Notion's title property is named "title" on standalone pages but is named
 * after the database column on database/data-source pages (commonly "Name").
 * The only stable signal is `type === 'title'` on the property value. We
 * return both the plain text and the property *key* so writers (which need
 * the key to call `properties.update`) don't have to re-scan.
 */
const findTitleProperty = (
  properties: Record<string, unknown>,
): { readonly key: string; readonly title: string } => {
  for (const [key, property] of Object.entries(properties)) {
    if (typeof property !== 'object' || property === null || 'type' in property === false) {
      continue
    }
    const typed = property as {
      readonly type?: unknown
      readonly title?: readonly { readonly plain_text?: unknown }[]
    }
    if (typed.type === 'title' && Array.isArray(typed.title) === true) {
      const title = typed.title
        .map((part) => (typeof part.plain_text === 'string' ? part.plain_text : ''))
        .join('')
      return { key, title }
    }
  }
  /*
   * Default key matches Notion's standalone-page convention. If we reach
   * here the property scan didn't find a title property at all (unusual
   * but possible for archived/locked pages); the title is empty and any
   * later write keyed on `"title"` will fail loudly at the API.
   */
  return { key: 'title', title: 'Untitled' }
}

const toRemotePage = (page: Page): RemotePageSnapshot => {
  const titleProperty = findTitleProperty(page.properties)
  return {
    id: page.id,
    title: titleProperty.title,
    title_property_key: titleProperty.key,
    url: page.url,
    parent: page.parent,
    icon: page.icon,
    cover: page.cover,
    in_trash: page.in_trash,
    is_locked: page.is_locked ?? false,
    last_edited_time: page.last_edited_time,
    properties: page.properties,
  }
}

const toRemoteChildPage = (block: Block): RemoteChildPage | undefined => {
  if (block.type !== 'child_page') return undefined
  const childPage = block.child_page
  if (
    typeof childPage !== 'object' ||
    childPage === null ||
    'title' in childPage === false ||
    typeof childPage.title !== 'string'
  ) {
    return undefined
  }
  return { pageId: block.id, title: childPage.title }
}

const blockPayload = (block: Block): unknown => {
  const value = block[block.type]
  return value === undefined ? {} : value
}

const storageFromUnknownBlocks = (opts: {
  readonly blocks: readonly Block[]
  readonly placeholders: readonly string[]
}): NmdStorage => ({
  _tag: 'self_contained',
  unsupported_blocks: opts.blocks.map((block, index) => ({
    _tag: 'unsupported_block',
    block_id: block.id,
    block_type: block.type,
    placeholder: opts.placeholders[index] ?? `<unknown alt="${block.type}"/>`,
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

const mapGatewayError =
  (opts: { readonly operation: string; readonly pageId?: string; readonly blockId?: string }) =>
  (cause: unknown): NmdGatewayError =>
    new NmdGatewayError({
      operation: opts.operation,
      page_id: opts.pageId,
      block_id: opts.blockId,
      cause,
      message:
        opts.pageId === undefined
          ? `Notion gateway operation failed: ${opts.operation}`
          : `Notion gateway operation failed for page ${opts.pageId}: ${opts.operation}`,
    })

const toNotionUpdateMarkdownOptions = (opts: {
  readonly pageId: string
  readonly command: MarkdownUpdateCommand
  readonly allowDeletingContent: boolean
}): UpdateMarkdownOptions => {
  switch (opts.command._tag) {
    case 'update_content':
      return {
        pageId: opts.pageId,
        type: 'update_content',
        content_updates: opts.command.contentUpdates.map((update) =>
          update.replaceAllMatches === undefined
            ? {
                old_str: update.oldStr,
                new_str: update.newStr,
              }
            : {
                old_str: update.oldStr,
                new_str: update.newStr,
                replace_all_matches: update.replaceAllMatches,
              },
        ),
        allow_deleting_content: opts.allowDeletingContent,
      }
    case 'replace_content':
      return {
        pageId: opts.pageId,
        type: 'replace_content',
        /*
         * Pre-canonicalize the body at the wire boundary so Notion stores one
         * Notion block per logical paragraph instead of one block per soft-wrap
         * line. Without this, hard-wrapped source paragraphs render as a chain
         * of broken lines on Notion.
         */
        new_str: canonicalizeBlockMarkdown(opts.command.markdown),
        allow_deleting_content: opts.allowDeletingContent,
      }
  }
}

/** Live Notion-backed gateway for page Markdown and page property operations. */
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
            /*
             * Canonicalize on pull so the on-disk body, the base snapshot,
             * and every diff `planMarkdownUpdate` sees are all in the
             * canonical form. This makes the wire boundary canonical
             * *by construction* for both `replace_content` and
             * `update_content` — without it, `update_content`'s
             * `old_str`/`new_str` would still reference user-wrap-form
             * text and Notion would render new paragraphs with soft
             * breaks intact (the gap called out in the proposal's
             * "Apply on pull too" guidance).
             */
            markdown: canonicalizeBlockMarkdown(markdown.markdown),
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
                storage: storageFromUnknownBlocks({
                  blocks: unknownBlocks,
                  placeholders: unknownPlaceholders(markdown.markdown),
                }),
              }
        }).pipe(
          Effect.mapError(mapGatewayError({ operation: 'pull_page', pageId })),
          Effect.withSpan('notion-md.gateway.pull-page', {
            attributes: { 'span.label': pageId.slice(0, 8), 'notion_md.page_id': pageId },
          }),
        ),
      updateMarkdown: ({ pageId, command, allowDeletingContent }) =>
        provideHttp(
          NotionPages.updateMarkdown(
            toNotionUpdateMarkdownOptions({
              pageId,
              command,
              allowDeletingContent,
            }),
          ),
        ).pipe(
          Effect.flatMap((markdownResult) => {
            const remoteMarkdown = {
              markdown: normalizeMarkdownLineEndings(markdownResult.markdown),
              truncated: markdownResult.truncated,
              unknown_block_ids: markdownResult.unknown_block_ids,
            }
            /*
             * Compare semantically rather than byte-equal. Notion reserializes
             * received Markdown into its own block model (collapses blank
             * lines, switches list-indent style); a strict byte-equal check
             * fails on every push of non-trivial content even though the
             * page was updated correctly. semanticEquivalent reduces both
             * sides to whitespace-collapsed canonical tokens, so genuine
             * content drift still trips the guard while Notion's reflow no
             * longer does.
             */
            if (
              command._tag === 'update_content' &&
              semanticEquivalent({ a: remoteMarkdown.markdown, b: command.expectedMarkdown }) ===
                false
            ) {
              return Effect.fail(
                new NmdGatewayError({
                  operation: 'update_markdown',
                  page_id: pageId,
                  message: `Notion gateway operation failed for page ${pageId}: update_markdown returned unexpected Markdown`,
                }),
              )
            }

            return Effect.succeed({ markdown: remoteMarkdown })
          }),
          Effect.mapError((cause) =>
            cause instanceof NmdGatewayError
              ? cause
              : mapGatewayError({ operation: 'update_markdown', pageId })(cause),
          ),
          Effect.withSpan('notion-md.gateway.update-markdown', {
            attributes: {
              'span.label': pageId.slice(0, 8),
              'notion_md.page_id': pageId,
              'notion_md.markdown_update.type': command._tag,
              'notion_md.markdown_update.allow_deleting_content': allowDeletingContent,
              'notion_md.markdown_update.content_update_count':
                command._tag === 'update_content' ? command.contentUpdates.length : 0,
            },
          }),
        ),
      updatePageProperties: ({ pageId, properties }) =>
        provideHttp(NotionPages.update({ pageId, properties })).pipe(
          Effect.map(toRemotePage),
          Effect.mapError(mapGatewayError({ operation: 'update_page_properties', pageId })),
          Effect.withSpan('notion-md.gateway.update-page-properties', {
            attributes: { 'span.label': pageId.slice(0, 8), 'notion_md.page_id': pageId },
          }),
        ),
      updatePageMetadata: ({ pageId, metadata }) =>
        provideHttp(
          NotionPages.update({
            pageId,
            /*
             * Title is a Notion *property* rather than a top-level page field.
             * Database/data-source pages name that property after the database
             * column (often `"Name"`), so we route the update through the key
             * `RemotePageSnapshot.title_property_key` captured at pull time —
             * never assume `properties.title`.
             */
            ...(metadata.title !== undefined
              ? {
                  properties: {
                    [metadata.title.key]: {
                      title: [{ type: 'text', text: { content: metadata.title.value } }],
                    },
                  },
                }
              : {}),
            ...(metadata.icon !== undefined ? { icon: metadata.icon } : {}),
            ...(metadata.cover !== undefined ? { cover: metadata.cover } : {}),
            ...(metadata.in_trash !== undefined ? { in_trash: metadata.in_trash } : {}),
            ...(metadata.is_locked !== undefined ? { is_locked: metadata.is_locked } : {}),
          }),
        ).pipe(
          Effect.map(toRemotePage),
          Effect.mapError(mapGatewayError({ operation: 'update_page_metadata', pageId })),
          Effect.withSpan('notion-md.gateway.update-page-metadata', {
            attributes: {
              'span.label': pageId.slice(0, 8),
              'notion_md.page_id': pageId,
              'notion_md.page_metadata.title': metadata.title !== undefined,
              'notion_md.page_metadata.icon': metadata.icon !== undefined,
              'notion_md.page_metadata.cover': metadata.cover !== undefined,
              'notion_md.page_metadata.in_trash': metadata.in_trash !== undefined,
              'notion_md.page_metadata.is_locked': metadata.is_locked !== undefined,
            },
          }),
        ),
      listChildPages: ({ pageId }) =>
        NotionBlocks.retrieveChildrenStream({ blockId: pageId }).pipe(
          Stream.provideService(NotionConfig, config),
          Stream.provideService(HttpClient.HttpClient, client),
          Stream.runCollect,
          Effect.map((blocks) =>
            Array.from(blocks).flatMap((block) => {
              const childPage = toRemoteChildPage(block)
              return childPage === undefined ? [] : [childPage]
            }),
          ),
          Effect.mapError(mapGatewayError({ operation: 'list_child_pages', pageId })),
          Effect.withSpan('notion-md.gateway.list-child-pages', {
            attributes: { 'span.label': pageId.slice(0, 8), 'notion_md.page_id': pageId },
          }),
        ),
    }
  }),
)
