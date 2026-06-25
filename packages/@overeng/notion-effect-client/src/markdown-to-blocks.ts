import type {
  NotionBlockCreate,
  TableRowBlockCreate as NotionTableRowBlockCreate,
  TextAnnotationsCreate as NotionTextAnnotationsCreate,
  TextRichTextCreate as NotionRichTextCreate,
} from '@overeng/notion-effect-schema'

import { parseNotionMarkdownAst } from './canonical-markdown.ts'

/** Short alias for Notion table-row create payloads. */
export type NotionTableRowCreate = NotionTableRowBlockCreate

export type {
  NotionBlockCreate,
  NotionRichTextCreate,
  NotionTableRowBlockCreate,
  NotionTextAnnotationsCreate,
}

interface MarkdownNode {
  readonly type?: string
  readonly value?: string
  readonly url?: string
  readonly depth?: number
  readonly ordered?: boolean
  readonly checked?: boolean | null
  readonly lang?: string | null
  readonly children?: readonly MarkdownNode[]
}

interface RichTextContext extends NotionTextAnnotationsCreate {
  readonly link?: string
}

const emptyRichText: readonly NotionRichTextCreate[] = [{ type: 'text', text: { content: '' } }]

const normalizeMarkdownForBlocks = (markdown: string): string =>
  markdown.replace(/<br\s*\/?>\s*/giu, '\n')

const isMarkdownNode = (value: unknown): value is MarkdownNode =>
  typeof value === 'object' && value !== null

const childrenOf = (node: MarkdownNode): readonly MarkdownNode[] => node.children ?? []

const annotationsFromContext = (
  context: RichTextContext,
): NotionTextAnnotationsCreate | undefined => {
  const annotations = {
    ...(context.bold === true ? { bold: true } : {}),
    ...(context.italic === true ? { italic: true } : {}),
    ...(context.strikethrough === true ? { strikethrough: true } : {}),
    ...(context.code === true ? { code: true } : {}),
  }
  return Object.keys(annotations).length === 0 ? undefined : annotations
}

const textSegment = ({
  content,
  context = {},
}: {
  readonly content: string
  readonly context?: RichTextContext
}): NotionRichTextCreate => {
  const annotations = annotationsFromContext(context)
  return {
    type: 'text',
    text: context.link === undefined ? { content } : { content, link: { url: context.link } },
    ...(annotations === undefined ? {} : { annotations }),
  }
}

const richTextFromNodes = ({
  nodes,
  context = {},
}: {
  readonly nodes: readonly MarkdownNode[]
  readonly context?: RichTextContext
}): readonly NotionRichTextCreate[] => {
  const richText: NotionRichTextCreate[] = []

  for (const node of nodes) {
    if (node.type === 'text') {
      if (node.value !== undefined && node.value.length > 0) {
        richText.push(textSegment({ content: node.value, context }))
      }
      continue
    }

    if (node.type === 'break') {
      richText.push(textSegment({ content: '\n', context }))
      continue
    }

    if (node.type === 'inlineCode') {
      richText.push(textSegment({ content: node.value ?? '', context: { ...context, code: true } }))
      continue
    }

    if (node.type === 'strong') {
      richText.push(
        ...richTextFromNodes({ nodes: childrenOf(node), context: { ...context, bold: true } }),
      )
      continue
    }

    if (node.type === 'emphasis') {
      richText.push(
        ...richTextFromNodes({ nodes: childrenOf(node), context: { ...context, italic: true } }),
      )
      continue
    }

    if (node.type === 'delete') {
      richText.push(
        ...richTextFromNodes({
          nodes: childrenOf(node),
          context: { ...context, strikethrough: true },
        }),
      )
      continue
    }

    if (node.type === 'link') {
      richText.push(
        ...richTextFromNodes({
          nodes: childrenOf(node),
          context: node.url === undefined ? context : { ...context, link: node.url },
        }),
      )
      continue
    }

    richText.push(...richTextFromNodes({ nodes: childrenOf(node), context }))
  }

  return richText.length === 0 ? emptyRichText : richText
}

const richTextFromListItem = (node: MarkdownNode): readonly NotionRichTextCreate[] => {
  const firstParagraph = childrenOf(node).find((child) => child.type === 'paragraph')
  return firstParagraph === undefined
    ? richTextFromNodes({ nodes: childrenOf(node) })
    : richTextFromNodes({ nodes: childrenOf(firstParagraph) })
}

const nestedListChildren = (node: MarkdownNode): readonly NotionBlockCreate[] =>
  childrenOf(node).flatMap((child) => (child.type === 'list' ? blocksFromNodes([child]) : []))

const withChildren = <TValue extends Record<string, unknown>>({
  value,
  children,
}: {
  readonly value: TValue
  readonly children: readonly NotionBlockCreate[]
}): TValue & { readonly children?: readonly NotionBlockCreate[] } =>
  children.length === 0 ? value : { ...value, children }

const listItemBlock = ({
  node,
  type,
}: {
  readonly node: MarkdownNode
  readonly type: 'bulleted_list_item' | 'numbered_list_item' | 'to_do'
}): NotionBlockCreate => {
  const children = nestedListChildren(node)
  const richText = richTextFromListItem(node)

  if (type === 'to_do') {
    return {
      object: 'block',
      type,
      to_do: withChildren({
        value: { rich_text: richText, checked: node.checked === true },
        children,
      }),
    }
  }

  return type === 'bulleted_list_item'
    ? {
        object: 'block',
        type,
        bulleted_list_item: withChildren({ value: { rich_text: richText }, children }),
      }
    : {
        object: 'block',
        type,
        numbered_list_item: withChildren({ value: { rich_text: richText }, children }),
      }
}

const tableCellRichText = (node: MarkdownNode | undefined): readonly NotionRichTextCreate[] => {
  if (node === undefined) return emptyRichText
  const children = childrenOf(node)
  return children.length === 0 ? emptyRichText : richTextFromNodes({ nodes: children })
}

const tableBlock = (node: MarkdownNode): NotionBlockCreate => {
  const rows = childrenOf(node).filter((child) => child.type === 'tableRow')
  const width = Math.max(
    1,
    ...rows.map((row) => childrenOf(row).filter((cell) => cell.type === 'tableCell').length),
  )

  return {
    object: 'block',
    type: 'table',
    table: {
      table_width: width,
      has_column_header: rows.length > 0,
      has_row_header: false,
      children: rows.map((row) => {
        const cells = childrenOf(row).filter((cell) => cell.type === 'tableCell')
        return {
          object: 'block',
          type: 'table_row',
          table_row: {
            cells: Array.from({ length: width }, (_unused, index) =>
              tableCellRichText(cells[index]),
            ),
          },
        }
      }),
    },
  }
}

const codeLanguage = (node: MarkdownNode): string => {
  const language = node.lang?.trim()
  return language === undefined || language.length === 0 ? 'plain text' : language
}

const quoteText = (node: MarkdownNode): readonly NotionRichTextCreate[] => {
  const firstParagraph = childrenOf(node).find((child) => child.type === 'paragraph')
  return firstParagraph === undefined
    ? emptyRichText
    : richTextFromNodes({ nodes: childrenOf(firstParagraph) })
}

const quoteChildren = (node: MarkdownNode): readonly NotionBlockCreate[] =>
  childrenOf(node).flatMap((child) => (child.type === 'paragraph' ? [] : blocksFromNodes([child])))

const blocksFromNodes = (nodes: readonly MarkdownNode[]): readonly NotionBlockCreate[] => {
  const blocks: NotionBlockCreate[] = []

  for (const node of nodes) {
    if (node.type === 'paragraph') {
      blocks.push({
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: richTextFromNodes({ nodes: childrenOf(node) }) },
      })
      continue
    }

    if (node.type === 'heading') {
      const level = Math.min(Math.max(node.depth ?? 1, 1), 3) as 1 | 2 | 3
      const richText = richTextFromNodes({ nodes: childrenOf(node) })
      if (level === 1) {
        blocks.push({ object: 'block', type: 'heading_1', heading_1: { rich_text: richText } })
      } else if (level === 2) {
        blocks.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: richText } })
      } else {
        blocks.push({ object: 'block', type: 'heading_3', heading_3: { rich_text: richText } })
      }
      continue
    }

    if (node.type === 'thematicBreak') {
      blocks.push({ object: 'block', type: 'divider', divider: {} })
      continue
    }

    if (node.type === 'list') {
      const listType = node.ordered === true ? 'numbered_list_item' : 'bulleted_list_item'
      for (const child of childrenOf(node)) {
        if (child.type === 'listItem') {
          blocks.push(
            listItemBlock({
              node: child,
              type: child.checked === true || child.checked === false ? 'to_do' : listType,
            }),
          )
        }
      }
      continue
    }

    if (node.type === 'blockquote') {
      const children = quoteChildren(node)
      blocks.push({
        object: 'block',
        type: 'quote',
        quote: withChildren({ value: { rich_text: quoteText(node) }, children }),
      })
      continue
    }

    if (node.type === 'code') {
      blocks.push({
        object: 'block',
        type: 'code',
        code: {
          rich_text: [textSegment({ content: node.value ?? '' })],
          language: codeLanguage(node),
        },
      })
      continue
    }

    if (node.type === 'table') {
      blocks.push(tableBlock(node))
      continue
    }

    blocks.push(...blocksFromNodes(childrenOf(node)))
  }

  return blocks
}

/**
 * Convert Markdown into Notion append-block payloads.
 *
 * This supports the CommonMark/GFM subset that maps cleanly to Notion's block
 * append API: paragraphs, headings 1-3, dividers, lists, task lists, quotes,
 * code, links, inline rich text, and GFM tables. The return values are
 * create/append payloads, not retrieved Notion blocks with ids and timestamps.
 */
export const markdownToBlocks = (markdown: string): readonly NotionBlockCreate[] => {
  const tree = parseNotionMarkdownAst(normalizeMarkdownForBlocks(markdown))
  if (isMarkdownNode(tree) === false) return []
  return blocksFromNodes(childrenOf(tree))
}
