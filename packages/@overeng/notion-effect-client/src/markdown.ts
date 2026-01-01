/**
 * Effect-native Notion blocks to Markdown converter.
 *
 * @module
 */

import type { HttpClient } from '@effect/platform'
import { type Block, type RichTextArray, RichTextUtils } from '@overeng/notion-effect-schema'
import { Effect } from 'effect'
import {
  type BlockTree,
  type BlockTreeNode,
  type BlockWithDepth,
  NotionBlocks,
  type RetrieveNestedOptions,
} from './blocks.ts'
import type { NotionConfig } from './config.ts'
import type { NotionApiError } from './error.ts'

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Custom transformer for a specific block type (sync version).
 *
 * Use the block helper functions to access block-specific data safely:
 * - `getBlockRichText(block)` - Get rich text content
 * - `getBlockCaption(block)` - Get media caption
 * - `getBlockUrl(block)` - Get URL from media/embed blocks
 * - `isTodoChecked(block)` - Check if to-do is checked
 * - `getCodeLanguage(block)` - Get code block language
 * - `getCalloutIcon(block)` - Get callout emoji icon
 *
 * @example
 * ```ts
 * const imageTransformer: BlockTransformer = (block) => {
 *   const url = getBlockUrl(block)
 *   const caption = RichTextUtils.toPlainText(getBlockCaption(block))
 *   return url ? `<InfoImage src="${url}" alt="${caption}" />` : ''
 * }
 * ```
 */
export type BlockTransformer = (block: BlockWithData, children: string) => string

/**
 * Custom transformer for a specific block type (Effect version).
 *
 * @see BlockTransformer for helper functions
 */
export type BlockTransformerEffect = (
  block: BlockWithData,
  children: string,
) => Effect.Effect<string, never, never>

/** Block transformer that can be sync or async */
export type AnyBlockTransformer = BlockTransformer | BlockTransformerEffect

/** Custom transformers for block types */
export interface BlockTransformers {
  readonly [blockType: string]: AnyBlockTransformer
}

/** Options for converting blocks to Markdown */
export interface BlocksToMarkdownOptions {
  /** Custom transformers for specific block types */
  readonly transformers?: BlockTransformers
  /** Indentation string for nested content (default: '  ') */
  readonly indent?: string
}

/** Options for converting a page to Markdown */
export interface PageToMarkdownOptions extends BlocksToMarkdownOptions, RetrieveNestedOptions {}

// -----------------------------------------------------------------------------
// Block Type Helpers
// -----------------------------------------------------------------------------

/** Block with type-specific data accessible via block[block.type] */
export type BlockWithData = Block & { readonly [key: string]: unknown }

// -----------------------------------------------------------------------------
// Block Content Extraction Helpers
// -----------------------------------------------------------------------------

/**
 * Get rich text content from a block.
 *
 * Works with paragraph, headings, lists, quotes, callouts, and other text-based blocks.
 *
 * @example
 * ```ts
 * const richText = getBlockRichText(block)
 * const plainText = RichTextUtils.toPlainText(richText)
 * ```
 */
export const getBlockRichText = (block: BlockWithData): RichTextArray => {
  const typeData = block[block.type] as { rich_text?: RichTextArray } | undefined
  return typeData?.rich_text ?? []
}

/**
 * Get caption from media blocks (image, video, audio, file, pdf, embed, bookmark).
 *
 * @example
 * ```ts
 * const caption = getBlockCaption(block)
 * const captionText = RichTextUtils.toPlainText(caption)
 * ```
 */
export const getBlockCaption = (block: BlockWithData): RichTextArray => {
  const typeData = block[block.type] as { caption?: RichTextArray } | undefined
  return typeData?.caption ?? []
}

/**
 * Get URL from various block types (image, video, audio, file, pdf, bookmark, embed, link_preview).
 *
 * Handles both external URLs and Notion-hosted file URLs.
 *
 * @example
 * ```ts
 * const url = getBlockUrl(block)
 * if (url) {
 *   return `<img src="${url}" />`
 * }
 * ```
 */
export const getBlockUrl = (block: BlockWithData): string | undefined => {
  const typeData = block[block.type] as
    | {
        url?: string
        external?: { url: string }
        file?: { url: string }
      }
    | undefined

  if (typeData?.url) return typeData.url
  if (typeData?.external?.url) return typeData.external.url
  if (typeData?.file?.url) return typeData.file.url
  return undefined
}

/**
 * Check if a to-do block is checked.
 *
 * @example
 * ```ts
 * const checkbox = isTodoChecked(block) ? '[x]' : '[ ]'
 * ```
 */
export const isTodoChecked = (block: BlockWithData): boolean => {
  const typeData = block[block.type] as { checked?: boolean } | undefined
  return typeData?.checked ?? false
}

/**
 * Get code block language.
 *
 * @example
 * ```ts
 * const lang = getCodeLanguage(block)
 * return `\`\`\`${lang}\n${code}\n\`\`\``
 * ```
 */
export const getCodeLanguage = (block: BlockWithData): string => {
  const typeData = block[block.type] as { language?: string } | undefined
  return typeData?.language ?? ''
}

/**
 * Get callout icon (emoji).
 *
 * @example
 * ```ts
 * const icon = getCalloutIcon(block)
 * return `> ${icon} ${text}`
 * ```
 */
export const getCalloutIcon = (block: BlockWithData): string => {
  const typeData = block[block.type] as { icon?: { emoji?: string } } | undefined
  return typeData?.icon?.emoji ?? ''
}

/**
 * Get child page title.
 *
 * @example
 * ```ts
 * const title = getChildPageTitle(block)
 * return `[${title}](/pages/${block.id})`
 * ```
 */
export const getChildPageTitle = (block: BlockWithData): string => {
  const typeData = block[block.type] as { title?: string } | undefined
  return typeData?.title ?? 'Untitled'
}

/**
 * Get child database title.
 *
 * @example
 * ```ts
 * const title = getChildDatabaseTitle(block)
 * return `[${title}](/databases/${block.id})`
 * ```
 */
export const getChildDatabaseTitle = (block: BlockWithData): string => {
  const typeData = block[block.type] as { title?: string } | undefined
  return typeData?.title ?? 'Untitled Database'
}

/**
 * Get table row cells as rich text arrays.
 *
 * @example
 * ```ts
 * const cells = getTableRowCells(block)
 * const row = cells.map(cell => RichTextUtils.toPlainText(cell)).join(' | ')
 * ```
 */
export const getTableRowCells = (block: BlockWithData): readonly RichTextArray[] => {
  const typeData = block[block.type] as { cells?: RichTextArray[] } | undefined
  return typeData?.cells ?? []
}

/**
 * Get equation expression.
 *
 * @example
 * ```ts
 * const expr = getEquationExpression(block)
 * return `$$\n${expr}\n$$`
 * ```
 */
export const getEquationExpression = (block: BlockWithData): string => {
  const typeData = block[block.type] as { expression?: string } | undefined
  return typeData?.expression ?? ''
}

// -----------------------------------------------------------------------------
// Default Block Transformers
// -----------------------------------------------------------------------------

/** Convert rich text to markdown */
const richTextToMd = (richText: RichTextArray): string => RichTextUtils.toMarkdown(richText)

/** Default transformer for paragraph blocks */
const paragraphTransformer: BlockTransformer = (block, children) => {
  const text = richTextToMd(getBlockRichText(block))
  return children ? `${text}\n\n${children}` : text
}

/** Default transformer for heading 1 blocks */
const heading1Transformer: BlockTransformer = (block) => {
  const text = richTextToMd(getBlockRichText(block))
  return `# ${text}`
}

/** Default transformer for heading 2 blocks */
const heading2Transformer: BlockTransformer = (block) => {
  const text = richTextToMd(getBlockRichText(block))
  return `## ${text}`
}

/** Default transformer for heading 3 blocks */
const heading3Transformer: BlockTransformer = (block) => {
  const text = richTextToMd(getBlockRichText(block))
  return `### ${text}`
}

/** Default transformer for bulleted list item blocks */
const bulletedListItemTransformer: BlockTransformer = (block, children) => {
  const text = richTextToMd(getBlockRichText(block))
  if (children) {
    const indentedChildren = children
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n')
    return `- ${text}\n${indentedChildren}`
  }
  return `- ${text}`
}

/** Default transformer for numbered list item blocks */
const numberedListItemTransformer: BlockTransformer = (block, children) => {
  const text = richTextToMd(getBlockRichText(block))
  if (children) {
    const indentedChildren = children
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n')
    return `1. ${text}\n${indentedChildren}`
  }
  return `1. ${text}`
}

/** Default transformer for to-do blocks */
const todoTransformer: BlockTransformer = (block, children) => {
  const text = richTextToMd(getBlockRichText(block))
  const checkbox = isTodoChecked(block) ? '[x]' : '[ ]'
  if (children) {
    const indentedChildren = children
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n')
    return `- ${checkbox} ${text}\n${indentedChildren}`
  }
  return `- ${checkbox} ${text}`
}

/** Default transformer for toggle blocks */
const toggleTransformer: BlockTransformer = (block, children) => {
  const text = richTextToMd(getBlockRichText(block))
  // Use HTML details/summary for toggles
  if (children) {
    return `<details>\n<summary>${text}</summary>\n\n${children}\n</details>`
  }
  return `<details>\n<summary>${text}</summary>\n</details>`
}

/** Default transformer for quote blocks */
const quoteTransformer: BlockTransformer = (block, children) => {
  const text = richTextToMd(getBlockRichText(block))
  const quotedText = text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
  if (children) {
    const quotedChildren = children
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')
    return `${quotedText}\n${quotedChildren}`
  }
  return quotedText
}

/** Default transformer for callout blocks */
const calloutTransformer: BlockTransformer = (block, children) => {
  const text = richTextToMd(getBlockRichText(block))
  const icon = getCalloutIcon(block)
  const prefix = icon ? `${icon} ` : ''
  // Use blockquote with icon for callouts
  const quotedText = `> ${prefix}${text}`
  if (children) {
    const quotedChildren = children
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')
    return `${quotedText}\n${quotedChildren}`
  }
  return quotedText
}

/** Default transformer for code blocks */
const codeTransformer: BlockTransformer = (block) => {
  const text = richTextToMd(getBlockRichText(block))
  const language = getCodeLanguage(block)
  return `\`\`\`${language}\n${text}\n\`\`\``
}

/** Default transformer for divider blocks */
const dividerTransformer: BlockTransformer = () => '---'

/** Default transformer for image blocks */
const imageTransformer: BlockTransformer = (block) => {
  const url = getBlockUrl(block)
  const caption = richTextToMd(getBlockCaption(block))
  if (!url) return ''
  return `![${caption}](${url})`
}

/** Default transformer for video blocks */
const videoTransformer: BlockTransformer = (block) => {
  const url = getBlockUrl(block)
  const caption = richTextToMd(getBlockCaption(block))
  if (!url) return ''
  return caption ? `[${caption}](${url})` : `[Video](${url})`
}

/** Default transformer for audio blocks */
const audioTransformer: BlockTransformer = (block) => {
  const url = getBlockUrl(block)
  const caption = richTextToMd(getBlockCaption(block))
  if (!url) return ''
  return caption ? `[${caption}](${url})` : `[Audio](${url})`
}

/** Default transformer for file blocks */
const fileTransformer: BlockTransformer = (block) => {
  const url = getBlockUrl(block)
  const caption = richTextToMd(getBlockCaption(block))
  if (!url) return ''
  return caption ? `[${caption}](${url})` : `[File](${url})`
}

/** Default transformer for PDF blocks */
const pdfTransformer: BlockTransformer = (block) => {
  const url = getBlockUrl(block)
  const caption = richTextToMd(getBlockCaption(block))
  if (!url) return ''
  return caption ? `[${caption}](${url})` : `[PDF](${url})`
}

/** Default transformer for bookmark blocks */
const bookmarkTransformer: BlockTransformer = (block) => {
  const url = getBlockUrl(block)
  const caption = richTextToMd(getBlockCaption(block))
  if (!url) return ''
  return caption ? `[${caption}](${url})` : `[${url}](${url})`
}

/** Default transformer for embed blocks */
const embedTransformer: BlockTransformer = (block) => {
  const url = getBlockUrl(block)
  const caption = richTextToMd(getBlockCaption(block))
  if (!url) return ''
  return caption ? `[${caption}](${url})` : `[Embed](${url})`
}

/** Default transformer for link preview blocks */
const linkPreviewTransformer: BlockTransformer = (block) => {
  const url = getBlockUrl(block)
  if (!url) return ''
  return `[${url}](${url})`
}

/** Default transformer for equation blocks */
const equationTransformer: BlockTransformer = (block) => {
  const expression = getEquationExpression(block)
  return `$$\n${expression}\n$$`
}

/** Default transformer for table of contents blocks */
const tableOfContentsTransformer: BlockTransformer = () => '[TOC]'

/** Default transformer for breadcrumb blocks */
const breadcrumbTransformer: BlockTransformer = () => ''

/** Default transformer for column list blocks */
const columnListTransformer: BlockTransformer = (_, children) => children

/** Default transformer for column blocks */
const columnTransformer: BlockTransformer = (_, children) => children

/** Default transformer for synced block blocks */
const syncedBlockTransformer: BlockTransformer = (_, children) => children

/** Default transformer for child page blocks */
const childPageTransformer: BlockTransformer = (block) => {
  const title = getChildPageTitle(block)
  return `[${title}]()`
}

/** Default transformer for child database blocks */
const childDatabaseTransformer: BlockTransformer = (block) => {
  const title = getChildDatabaseTitle(block)
  return `[${title}]()`
}

/** Default transformer for table blocks (basic) */
const tableTransformer: BlockTransformer = (_, children) => {
  // Tables need special handling - children are table rows
  return children
}

/** Default transformer for table row blocks (basic) */
const tableRowTransformer: BlockTransformer = (block) => {
  const cells = getTableRowCells(block)
  const cellTexts = cells.map((cell) => richTextToMd(cell))
  return `| ${cellTexts.join(' | ')} |`
}

/** Default transformer for template blocks */
const templateTransformer: BlockTransformer = (block, children) => {
  const text = richTextToMd(getBlockRichText(block))
  return children ? `${text}\n\n${children}` : text
}

/** Default transformer for link to page blocks */
const linkToPageTransformer: BlockTransformer = (block) => {
  const typeData = block[block.type] as { page_id?: string; database_id?: string } | undefined
  const pageId = typeData?.page_id ?? typeData?.database_id ?? ''
  return `[Link to page](https://notion.so/${pageId.replace(/-/g, '')})`
}

/** Default transformer for unsupported blocks */
const unsupportedTransformer: BlockTransformer = () => ''

/** Default transformers for all block types */
const DEFAULT_TRANSFORMERS: Record<string, BlockTransformer> = {
  paragraph: paragraphTransformer,
  heading_1: heading1Transformer,
  heading_2: heading2Transformer,
  heading_3: heading3Transformer,
  bulleted_list_item: bulletedListItemTransformer,
  numbered_list_item: numberedListItemTransformer,
  to_do: todoTransformer,
  toggle: toggleTransformer,
  quote: quoteTransformer,
  callout: calloutTransformer,
  code: codeTransformer,
  divider: dividerTransformer,
  image: imageTransformer,
  video: videoTransformer,
  audio: audioTransformer,
  file: fileTransformer,
  pdf: pdfTransformer,
  bookmark: bookmarkTransformer,
  embed: embedTransformer,
  link_preview: linkPreviewTransformer,
  equation: equationTransformer,
  table_of_contents: tableOfContentsTransformer,
  breadcrumb: breadcrumbTransformer,
  column_list: columnListTransformer,
  column: columnTransformer,
  synced_block: syncedBlockTransformer,
  child_page: childPageTransformer,
  child_database: childDatabaseTransformer,
  table: tableTransformer,
  table_row: tableRowTransformer,
  template: templateTransformer,
  link_to_page: linkToPageTransformer,
  unsupported: unsupportedTransformer,
}

// -----------------------------------------------------------------------------
// Markdown Conversion Implementation
// -----------------------------------------------------------------------------

/** Apply a transformer (sync or async) */
const applyTransformer = (
  transformer: AnyBlockTransformer,
  block: Block & { [key: string]: unknown },
  children: string,
): Effect.Effect<string, never, never> => {
  const result = transformer(block, children)
  if (Effect.isEffect(result)) {
    return result
  }
  return Effect.succeed(result)
}

/** Convert a single block tree node to Markdown */
const nodeToMarkdown = (
  node: BlockTreeNode,
  transformers: BlockTransformers,
): Effect.Effect<string, never, never> =>
  Effect.gen(function* () {
    // First, recursively convert all children
    const childMarkdowns = yield* Effect.forEach(node.children, (child) =>
      nodeToMarkdown(child, transformers),
    )
    const childrenMd = childMarkdowns.filter((s) => s.length > 0).join('\n\n')

    // Get the transformer for this block type
    const transformer = transformers[node.block.type] ?? DEFAULT_TRANSFORMERS[node.block.type]
    if (!transformer) {
      return childrenMd
    }

    // Apply the transformer
    const blockWithData = node.block as Block & { [key: string]: unknown }
    return yield* applyTransformer(transformer, blockWithData, childrenMd)
  })

/**
 * Convert a block tree to Markdown.
 *
 * @example
 * ```ts
 * const tree = yield* NotionBlocks.retrieveAsTree({ blockId: pageId })
 * const markdown = yield* NotionMarkdown.treeToMarkdown({ tree })
 * ```
 */
export const treeToMarkdown = (opts: {
  readonly tree: BlockTree
  readonly transformers?: BlockTransformers
}): Effect.Effect<string, never, never> => {
  const transformers = opts.transformers ?? {}

  return Effect.gen(function* () {
    const nodeMarkdowns = yield* Effect.forEach(opts.tree, (node) =>
      nodeToMarkdown(node, transformers),
    )

    return nodeMarkdowns.filter((s) => s.length > 0).join('\n\n')
  }).pipe(Effect.withSpan('NotionMarkdown.treeToMarkdown'))
}

/**
 * Convert pre-fetched blocks (with depth info) to Markdown.
 *
 * Note: This function assumes blocks are in depth-first order.
 * For more accurate results, use `treeToMarkdown` with a block tree.
 *
 * @example
 * ```ts
 * const blocks = yield* Stream.runCollect(NotionBlocks.retrieveAllNested({ blockId }))
 * const markdown = yield* NotionMarkdown.blocksToMarkdown({ blocks: [...blocks] })
 * ```
 */
export const blocksToMarkdown = (opts: {
  readonly blocks: readonly BlockWithDepth[]
  readonly transformers?: BlockTransformers
}): Effect.Effect<string, never, never> => {
  const transformers = opts.transformers ?? {}

  // Convert flat blocks to a tree structure first
  const tree = blocksWithDepthToTree(opts.blocks)

  // Then convert the tree to markdown
  return treeToMarkdown({ tree, transformers }).pipe(
    Effect.withSpan('NotionMarkdown.blocksToMarkdown'),
  )
}

/** Convert flat blocks with depth to tree structure */
const blocksWithDepthToTree = (blocks: readonly BlockWithDepth[]): BlockTree => {
  if (blocks.length === 0) return []

  const roots: BlockTreeNode[] = []
  const nodeStack: { node: BlockTreeNode; depth: number }[] = []

  for (const { block, depth } of blocks) {
    const newNode: BlockTreeNode = { block, children: [] }

    if (depth === 0) {
      roots.push(newNode)
      nodeStack.length = 0
      nodeStack.push({ node: newNode, depth: 0 })
    } else {
      // Find the parent at depth - 1
      while (nodeStack.length > 0 && (nodeStack[nodeStack.length - 1]?.depth ?? -1) >= depth) {
        nodeStack.pop()
      }

      const parentEntry = nodeStack[nodeStack.length - 1]
      if (parentEntry !== undefined) {
        ;(parentEntry.node.children as BlockTreeNode[]).push(newNode)
      } else {
        // Orphan block, add as root
        roots.push(newNode)
      }

      nodeStack.push({ node: newNode, depth })
    }
  }

  return roots
}

/**
 * Convert a Notion page to Markdown by fetching all blocks.
 *
 * @example
 * ```ts
 * const markdown = yield* NotionMarkdown.pageToMarkdown({
 *   pageId: 'abc123...',
 * })
 * ```
 *
 * @example With custom transformers
 * ```ts
 * const markdown = yield* NotionMarkdown.pageToMarkdown({
 *   pageId: 'abc123...',
 *   transformers: {
 *     image: (block) => `<Image src="${getBlockUrl(block)}" />`,
 *   },
 * })
 * ```
 */
export const pageToMarkdown = (
  opts: Omit<PageToMarkdownOptions, 'blockId'> & { readonly pageId: string },
): Effect.Effect<string, NotionApiError, NotionConfig | HttpClient.HttpClient> => {
  const { pageId, transformers, ...nestedOpts } = opts

  return Effect.gen(function* () {
    // Fetch all blocks as a tree
    const tree = yield* NotionBlocks.retrieveAsTree({
      blockId: pageId,
      ...nestedOpts,
    })

    // Convert to markdown
    return yield* treeToMarkdown(transformers ? { tree, transformers } : { tree })
  }).pipe(
    Effect.withSpan('NotionMarkdown.pageToMarkdown', { attributes: { 'notion.page_id': pageId } }),
  )
}

// -----------------------------------------------------------------------------
// Namespace Exports
// -----------------------------------------------------------------------------

/**
 * Block helper utilities for custom transformers.
 *
 * Use these helpers to safely extract data from Notion blocks without casts.
 *
 * @example
 * ```ts
 * const imageTransformer: BlockTransformer = (block) => {
 *   const url = BlockHelpers.getUrl(block)
 *   const caption = RichTextUtils.toPlainText(BlockHelpers.getCaption(block))
 *   return url ? `<InfoImage src="${url}" alt="${caption}" />` : ''
 * }
 * ```
 */
export const BlockHelpers = {
  /** Get rich text content from a block */
  getRichText: getBlockRichText,
  /** Get caption from media blocks */
  getCaption: getBlockCaption,
  /** Get URL from various block types */
  getUrl: getBlockUrl,
  /** Check if a to-do block is checked */
  isTodoChecked,
  /** Get code block language */
  getCodeLanguage,
  /** Get callout icon (emoji) */
  getCalloutIcon,
  /** Get child page title */
  getChildPageTitle,
  /** Get child database title */
  getChildDatabaseTitle,
  /** Get table row cells */
  getTableRowCells,
  /** Get equation expression */
  getEquationExpression,
} as const

/**
 * Notion Markdown converter utilities.
 *
 * @example
 * ```ts
 * // Convert a page to markdown
 * const markdown = yield* NotionMarkdown.pageToMarkdown({ pageId: '...' })
 *
 * // Convert pre-fetched blocks
 * const tree = yield* NotionBlocks.retrieveAsTree({ blockId: pageId })
 * const markdown = yield* NotionMarkdown.treeToMarkdown({ tree })
 *
 * // With custom transformers using BlockHelpers
 * const markdown = yield* NotionMarkdown.pageToMarkdown({
 *   pageId: '...',
 *   transformers: {
 *     image: (block) => {
 *       const url = BlockHelpers.getUrl(block)
 *       const caption = RichTextUtils.toPlainText(BlockHelpers.getCaption(block))
 *       return url ? `<InfoImage src="${url}" alt="${caption}" />` : ''
 *     },
 *   },
 * })
 * ```
 */
export const NotionMarkdown = {
  pageToMarkdown,
  treeToMarkdown,
  blocksToMarkdown,
} as const
