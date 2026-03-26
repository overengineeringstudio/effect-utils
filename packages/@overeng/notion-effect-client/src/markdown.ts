/**
 * Effect-native Notion blocks to Markdown converter.
 *
 * @module
 */

import { Effect } from 'effect'

import { type Block, type RichTextArray, RichTextUtils } from '@overeng/notion-effect-schema'

import {
  type BlockTree,
  type BlockTreeNode,
  type BlockWithDepth,
  NotionBlocks,
  type RetrieveNestedOptions,
} from './blocks.ts'

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

  if (typeData?.url !== undefined) return typeData.url
  if (typeData?.external?.url !== undefined) return typeData.external.url
  if (typeData?.file?.url !== undefined) return typeData.file.url
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

/** Indent each line of text */
const indentLines = ({ text, indent = '  ' }: { text: string; indent?: string }): string =>
  text
    .split('\n')
    .map((line) => `${indent}${line}`)
    .join('\n')

/** Quote each line of text */
const quoteLines = (text: string): string =>
  text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')

/** Default transformers for all block types */
// oxlint-disable overeng/named-args -- callback implementations for BlockTransformer interface
const DEFAULT_TRANSFORMERS: Record<string, BlockTransformer> = {
  paragraph: (block, children) => {
    const text = richTextToMd(getBlockRichText(block))
    return children !== '' ? `${text}\n\n${children}` : text
  },

  heading_1: (block) => `# ${richTextToMd(getBlockRichText(block))}`,
  heading_2: (block) => `## ${richTextToMd(getBlockRichText(block))}`,
  heading_3: (block) => `### ${richTextToMd(getBlockRichText(block))}`,

  bulleted_list_item: (block, children) => {
    const text = richTextToMd(getBlockRichText(block))
    return children !== '' ? `- ${text}\n${indentLines({ text: children })}` : `- ${text}`
  },

  numbered_list_item: (block, children) => {
    const text = richTextToMd(getBlockRichText(block))
    return children !== '' ? `1. ${text}\n${indentLines({ text: children })}` : `1. ${text}`
  },

  to_do: (block, children) => {
    const text = richTextToMd(getBlockRichText(block))
    const checkbox = isTodoChecked(block) === true ? '[x]' : '[ ]'
    return children !== ''
      ? `- ${checkbox} ${text}\n${indentLines({ text: children })}`
      : `- ${checkbox} ${text}`
  },

  toggle: (block, children) => {
    const text = richTextToMd(getBlockRichText(block))
    return children !== ''
      ? `<details>\n<summary>${text}</summary>\n\n${children}\n</details>`
      : `<details>\n<summary>${text}</summary>\n</details>`
  },

  quote: (block, children) => {
    const quotedText = quoteLines(richTextToMd(getBlockRichText(block)))
    return children !== '' ? `${quotedText}\n${quoteLines(children)}` : quotedText
  },

  callout: (block, children) => {
    const text = richTextToMd(getBlockRichText(block))
    const icon = getCalloutIcon(block)
    const prefix = icon !== undefined ? `${icon} ` : ''
    const quotedText = `> ${prefix}${text}`
    return children !== '' ? `${quotedText}\n${quoteLines(children)}` : quotedText
  },

  code: (block) => {
    const text = richTextToMd(getBlockRichText(block))
    const language = getCodeLanguage(block)
    return `\`\`\`${language}\n${text}\n\`\`\``
  },

  divider: () => '---',

  image: (block) => {
    const url = getBlockUrl(block)
    if (url === undefined) return ''
    return `![${richTextToMd(getBlockCaption(block))}](${url})`
  },

  video: (block) => {
    const url = getBlockUrl(block)
    if (url === undefined) return ''
    const caption = richTextToMd(getBlockCaption(block))
    return caption !== '' ? `[${caption}](${url})` : `[Video](${url})`
  },

  audio: (block) => {
    const url = getBlockUrl(block)
    if (url === undefined) return ''
    const caption = richTextToMd(getBlockCaption(block))
    return caption !== '' ? `[${caption}](${url})` : `[Audio](${url})`
  },

  file: (block) => {
    const url = getBlockUrl(block)
    if (url === undefined) return ''
    const caption = richTextToMd(getBlockCaption(block))
    return caption !== '' ? `[${caption}](${url})` : `[File](${url})`
  },

  pdf: (block) => {
    const url = getBlockUrl(block)
    if (url === undefined) return ''
    const caption = richTextToMd(getBlockCaption(block))
    return caption !== '' ? `[${caption}](${url})` : `[PDF](${url})`
  },

  bookmark: (block) => {
    const url = getBlockUrl(block)
    if (url === undefined) return ''
    const caption = richTextToMd(getBlockCaption(block))
    return caption !== '' ? `[${caption}](${url})` : `[${url}](${url})`
  },

  embed: (block) => {
    const url = getBlockUrl(block)
    if (url === undefined) return ''
    const caption = richTextToMd(getBlockCaption(block))
    return caption !== '' ? `[${caption}](${url})` : `[Embed](${url})`
  },

  link_preview: (block) => {
    const url = getBlockUrl(block)
    return url !== undefined ? `[${url}](${url})` : ''
  },

  equation: (block) => `$$\n${getEquationExpression(block)}\n$$`,

  table_of_contents: () => '[TOC]',
  breadcrumb: () => '',

  column_list: (_, children) => children,
  column: (_, children) => children,
  synced_block: (_, children) => children,
  table: (_, children) => children,

  child_page: (block) => `[${getChildPageTitle(block)}]()`,
  child_database: (block) => `[${getChildDatabaseTitle(block)}]()`,

  table_row: (block) => {
    const cells = getTableRowCells(block)
    return `| ${cells.map((cell) => richTextToMd(cell)).join(' | ')} |`
  },

  template: (block, children) => {
    const text = richTextToMd(getBlockRichText(block))
    return children !== '' ? `${text}\n\n${children}` : text
  },

  link_to_page: (block) => {
    const typeData = block[block.type] as { page_id?: string; database_id?: string } | undefined
    const pageId = typeData?.page_id ?? typeData?.database_id ?? ''
    return `[Link to page](https://notion.so/${pageId.replace(/-/g, '')})`
  },

  unsupported: () => '',
}
// oxlint-enable overeng/named-args

// -----------------------------------------------------------------------------
// Markdown Conversion Implementation
// -----------------------------------------------------------------------------

/** Apply a transformer (sync or async) */
const applyTransformer = (opts: {
  transformer: AnyBlockTransformer
  block: Block & { [key: string]: unknown }
  children: string
}): Effect.Effect<string, never, never> => {
  const { transformer, block, children } = opts
  const result = transformer(block, children)
  if (Effect.isEffect(result) === true) {
    return result
  }
  return Effect.succeed(result)
}

/** Convert a single block tree node to Markdown (recursive, needs explicit type) */
const nodeToMarkdown = (opts: {
  node: BlockTreeNode
  transformers: BlockTransformers
}): Effect.Effect<string> =>
  Effect.gen(function* () {
    const { node, transformers } = opts
    // First, recursively convert all children
    const childMarkdowns = yield* Effect.forEach(node.children, (child) =>
      nodeToMarkdown({ node: child, transformers }),
    )
    const childrenMd = childMarkdowns.filter((s) => s.length > 0).join('\n\n')

    // Get the transformer for this block type
    const transformer = transformers[node.block.type] ?? DEFAULT_TRANSFORMERS[node.block.type]
    if (transformer === undefined) {
      return childrenMd
    }

    // Apply the transformer
    const blockWithData = node.block as Block & { [key: string]: unknown }
    return yield* applyTransformer({
      transformer,
      block: blockWithData,
      children: childrenMd,
    })
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
export const treeToMarkdown = Effect.fn('NotionMarkdown.treeToMarkdown')(function* (opts: {
  readonly tree: BlockTree
  readonly transformers?: BlockTransformers
}) {
  const transformers = opts.transformers ?? {}

  const nodeMarkdowns = yield* Effect.forEach(opts.tree, (node) =>
    nodeToMarkdown({ node, transformers }),
  )

  return nodeMarkdowns.filter((s) => s.length > 0).join('\n\n')
})

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
export const blocksToMarkdown = Effect.fn('NotionMarkdown.blocksToMarkdown')(function* (opts: {
  readonly blocks: readonly BlockWithDepth[]
  readonly transformers?: BlockTransformers
}) {
  const transformers = opts.transformers ?? {}

  // Convert flat blocks to a tree structure first
  const tree = blocksWithDepthToTree(opts.blocks)

  // Then convert the tree to markdown
  return yield* treeToMarkdown({ tree, transformers })
})

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
export const pageToMarkdown = Effect.fn('NotionMarkdown.pageToMarkdown')(function* (
  opts: Omit<PageToMarkdownOptions, 'blockId'> & { readonly pageId: string },
) {
  const { pageId, transformers, ...nestedOpts } = opts

  // Fetch all blocks as a tree
  const tree = yield* NotionBlocks.retrieveAsTree({
    blockId: pageId,
    ...nestedOpts,
  })

  // Convert to markdown
  return yield* treeToMarkdown(transformers !== undefined ? { tree, transformers } : { tree })
})

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
// -----------------------------------------------------------------------------
// Markdown → Notion Blocks
// -----------------------------------------------------------------------------

const RICH_TEXT_CHUNK_SIZE = 2000

/** Parse inline markdown (**bold**, *italic*) into Notion rich_text elements */
export const parseInlineMarkdown = (text: string): Array<Record<string, unknown>> => {
  const elements: Array<Record<string, unknown>> = []
  const regex = /\*\*(.+?)\*\*|\*(.+?)\*/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index)
      if (before) elements.push({ type: 'text', text: { content: before } })
    }
    if (match[1]) {
      elements.push({
        type: 'text',
        text: { content: match[1] },
        annotations: { bold: true },
      })
    } else if (match[2]) {
      elements.push({
        type: 'text',
        text: { content: match[2] },
        annotations: { italic: true },
      })
    }
    lastIndex = match.index + match[0].length
  }

  const remaining = text.slice(lastIndex)
  if (remaining) elements.push({ type: 'text', text: { content: remaining } })

  if (elements.length === 0) elements.push({ type: 'text', text: { content: text } })

  return elements.flatMap((el) => {
    const content = (el as { text: { content: string } }).text.content
    if (content.length <= RICH_TEXT_CHUNK_SIZE) return [el]
    const chunks: Array<Record<string, unknown>> = []
    for (let i = 0; i < content.length; i += RICH_TEXT_CHUNK_SIZE) {
      chunks.push({
        ...el,
        text: { content: content.slice(i, i + RICH_TEXT_CHUNK_SIZE) },
      })
    }
    return chunks
  })
}

/** Parse a single table row (|col1|col2|) into cell strings */
const parseTableRow = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim())

/** Check if a line is a markdown table separator (|---|---| or |:---:|) */
const isTableSeparator = (line: string): boolean =>
  /^\|[\s:?-]+(\|[\s:?-]+)+\|?\s*$/.test(line.trim())

/** Parse markdown table lines into a Notion table block */
const parseMarkdownTable = (lines: string[]): Record<string, unknown> | undefined => {
  if (lines.length < 2) return undefined
  if (!lines.every((l) => l.trim().startsWith('|'))) return undefined

  const sepIdx = lines.findIndex((l) => isTableSeparator(l))
  if (sepIdx < 0) return undefined

  const headerLines = lines.slice(0, sepIdx)
  const dataLines = lines.slice(sepIdx + 1)

  const headerCells = headerLines.length > 0 ? parseTableRow(headerLines[0]!) : []
  const tableWidth = headerCells.length
  if (tableWidth === 0) return undefined

  const toRow = (cells: string[]) => ({
    type: 'table_row' as const,
    table_row: {
      cells: Array.from({ length: tableWidth }, (_, i) => parseInlineMarkdown(cells[i] ?? '')),
    },
  })

  const children = [
    toRow(headerCells),
    ...dataLines.filter((l) => l.trim().length > 0).map((l) => toRow(parseTableRow(l))),
  ]

  return {
    type: 'table',
    table: {
      table_width: tableWidth,
      has_column_header: true,
      has_row_header: false,
      children,
    },
  }
}

/** Convert markdown text to Notion blocks (headings, lists, dividers, paragraphs, tables) */
export const markdownToBlocks = (markdown: string): Array<Record<string, unknown>> => {
  const blocks: Array<Record<string, unknown>> = []
  const normalized = markdown.replace(/<br\s*\/?>\s*/gi, '\n')
  const rawParagraphs = normalized.split(/\n\n+/)
  const paragraphs: string[] = []
  for (const raw of rawParagraphs) {
    const lines = raw.split('\n')
    let current: string[] = []
    for (const line of lines) {
      const isBlockStart = /^#{1,3}\s|^-{3,}$|^- |^\d+\.\s/.test(line.trim())
      if (isBlockStart && current.length > 0) {
        paragraphs.push(current.join('\n'))
        current = [line]
      } else {
        current.push(line)
      }
    }
    if (current.length > 0) paragraphs.push(current.join('\n'))
  }

  for (const para of paragraphs) {
    const trimmed = para.trim()
    if (!trimmed) continue

    if (/^-{3,}$/.test(trimmed)) {
      blocks.push({ type: 'divider', divider: {} })
      continue
    }

    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/)
    if (headingMatch?.[1] && headingMatch[2]) {
      const level = headingMatch[1].length as 1 | 2 | 3
      const type = `heading_${level}` as const
      blocks.push({
        type,
        [type]: { rich_text: parseInlineMarkdown(headingMatch[2]) },
      })
      continue
    }

    const lines = trimmed.split('\n')
    const allBullets = lines.every((l) => l.trim().startsWith('- '))
    const allNumbered = lines.every((l) => /^\d+\.\s/.test(l.trim()))

    if (allBullets) {
      for (const line of lines) {
        const content = line.trim().replace(/^- /, '')
        blocks.push({
          type: 'bulleted_list_item',
          bulleted_list_item: { rich_text: parseInlineMarkdown(content) },
        })
      }
      continue
    }

    if (allNumbered) {
      for (const line of lines) {
        const content = line.trim().replace(/^\d+\.\s/, '')
        blocks.push({
          type: 'numbered_list_item',
          numbered_list_item: { rich_text: parseInlineMarkdown(content) },
        })
      }
      continue
    }

    const tableBlock = parseMarkdownTable(lines)
    if (tableBlock) {
      blocks.push(tableBlock)
      continue
    }

    const text = trimmed.replace(/  \n/g, '\n')
    blocks.push({
      type: 'paragraph',
      paragraph: { rich_text: parseInlineMarkdown(text) },
    })
  }

  return blocks
}

export const NotionMarkdown = {
  pageToMarkdown,
  treeToMarkdown,
  blocksToMarkdown,
  markdownToBlocks,
} as const
