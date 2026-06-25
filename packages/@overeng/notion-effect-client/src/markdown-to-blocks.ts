import remarkParse from 'remark-parse'
import { unified } from 'unified'

import { remarkNotionGfm } from './markdown-gfm.ts'

/** Rich-text payload accepted inside Notion block-children write requests. */
export type NotionRichTextCreate = {
  readonly type: 'text'
  readonly text: {
    readonly content: string
    readonly link?: { readonly url: string }
  }
  readonly annotations?: {
    readonly bold?: boolean
    readonly italic?: boolean
    readonly strikethrough?: boolean
    readonly code?: boolean
  }
}

/** Block-child payload accepted by `NotionBlocks.append`. */
export type NotionBlockCreate = Readonly<Record<string, unknown>>

type RichTextMarks = NonNullable<NotionRichTextCreate['annotations']>

type MdastNode = {
  readonly type: string
  readonly value?: string
  readonly url?: string
  readonly depth?: number
  readonly ordered?: boolean
  readonly checked?: boolean | null
  readonly children?: readonly MdastNode[]
}

const processor = unified().use(remarkParse).use(remarkNotionGfm)

const normalizeInput = (markdown: string): string =>
  markdown
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/<br\s*\/?>\s*/gi, '\n')

const hasMarks = (marks: RichTextMarks): boolean =>
  marks.bold === true ||
  marks.italic === true ||
  marks.strikethrough === true ||
  marks.code === true

const text = ({
  content,
  marks = {},
  url,
}: {
  content: string
  marks?: RichTextMarks
  url?: string
}): NotionRichTextCreate => ({
  type: 'text',
  text: url === undefined ? { content } : { content, link: { url } },
  ...(hasMarks(marks) === true ? { annotations: marks } : {}),
})

const markedText = ({
  content,
  marks,
  url,
}: {
  content: string
  marks: RichTextMarks
  url: string | undefined
}): NotionRichTextCreate => text({ content, marks, ...(url === undefined ? {} : { url }) })

const richTextFromNodes = (
  nodes: readonly MdastNode[] | undefined,
): readonly NotionRichTextCreate[] => {
  const segments: NotionRichTextCreate[] = []

  const visit = ({
    node,
    marks = {},
    linkUrl,
  }: {
    node: MdastNode
    marks?: RichTextMarks
    linkUrl?: string
  }): void => {
    switch (node.type) {
      case 'text':
        segments.push(markedText({ content: node.value ?? '', marks, url: linkUrl }))
        return
      case 'strong':
        node.children?.forEach((child) =>
          visitChild({ node: child, marks: { ...marks, bold: true }, linkUrl }),
        )
        return
      case 'emphasis':
        node.children?.forEach((child) =>
          visitChild({ node: child, marks: { ...marks, italic: true }, linkUrl }),
        )
        return
      case 'delete':
        node.children?.forEach((child) =>
          visitChild({ node: child, marks: { ...marks, strikethrough: true }, linkUrl }),
        )
        return
      case 'inlineCode':
        segments.push(
          markedText({ content: node.value ?? '', marks: { ...marks, code: true }, url: linkUrl }),
        )
        return
      case 'break':
        segments.push(markedText({ content: '\n', marks, url: linkUrl }))
        return
      case 'link':
        node.children?.forEach((child) =>
          visitChild({ node: child, marks, linkUrl: node.url ?? linkUrl }),
        )
        return
      case 'image':
        segments.push(markedText({ content: node.url ?? '', marks, url: node.url }))
        return
      default:
        if (node.children !== undefined) {
          node.children.forEach((child) => visitChild({ node: child, marks, linkUrl }))
        }
    }
  }
  const visitChild = ({
    node,
    marks,
    linkUrl,
  }: {
    node: MdastNode
    marks: RichTextMarks
    linkUrl: string | undefined
  }): void => visit({ node, marks, ...(linkUrl === undefined ? {} : { linkUrl }) })

  nodes?.forEach((node) => visit({ node }))
  return segments.length > 0 ? segments : [text({ content: '' })]
}

const blockWithRichText = ({
  type,
  richText,
}: {
  type: string
  richText: readonly NotionRichTextCreate[]
}): NotionBlockCreate => ({
  type,
  [type]: { rich_text: richText },
})

const tableCellRichText = (node: MdastNode | undefined): readonly NotionRichTextCreate[] =>
  richTextFromNodes(node?.children)

const tableBlock = (node: MdastNode): NotionBlockCreate => {
  const rows = node.children ?? []
  const tableWidth = Math.max(...rows.map((row) => row.children?.length ?? 0), 1)

  return {
    type: 'table',
    table: {
      table_width: tableWidth,
      has_column_header: true,
      has_row_header: false,
      children: rows.map((row) => ({
        type: 'table_row',
        table_row: {
          cells: Array.from({ length: tableWidth }, (_, index) =>
            tableCellRichText(row.children?.[index]),
          ),
        },
      })),
    },
  }
}

const listItemRichText = (node: MdastNode): readonly NotionRichTextCreate[] => {
  const children = node.children ?? []
  const paragraph = children.find((child) => child.type === 'paragraph')
  return richTextFromNodes(
    paragraph?.children ?? children.flatMap((child) => child.children ?? [child]),
  )
}

const listBlocks = (node: MdastNode): readonly NotionBlockCreate[] => {
  const type = node.ordered === true ? 'numbered_list_item' : 'bulleted_list_item'
  return (node.children ?? []).map((item) => {
    if (item.checked !== null && item.checked !== undefined) {
      return {
        type: 'to_do',
        to_do: {
          rich_text: listItemRichText(item),
          checked: item.checked,
        },
      }
    }

    return blockWithRichText({ type, richText: listItemRichText(item) })
  })
}

const rootBlockFromNode = (node: MdastNode): readonly NotionBlockCreate[] => {
  switch (node.type) {
    case 'paragraph':
      return [blockWithRichText({ type: 'paragraph', richText: richTextFromNodes(node.children) })]
    case 'heading': {
      const type = `heading_${Math.min(Math.max(node.depth ?? 1, 1), 3)}`
      return [blockWithRichText({ type, richText: richTextFromNodes(node.children) })]
    }
    case 'thematicBreak':
      return [{ type: 'divider', divider: {} }]
    case 'list':
      return listBlocks(node)
    case 'table':
      return [tableBlock(node)]
    case 'code':
      return [
        {
          type: 'code',
          code: {
            rich_text: richTextFromNodes([{ type: 'text', value: node.value ?? '' }]),
            language: 'plain text',
          },
        },
      ]
    default:
      return node.children === undefined
        ? []
        : [blockWithRichText({ type: 'paragraph', richText: richTextFromNodes(node.children) })]
  }
}

/**
 * Convert Notion-flavored Markdown into block children payloads accepted by
 * `NotionBlocks.append`.
 */
export const markdownToBlocks = (markdown: string): readonly NotionBlockCreate[] => {
  const tree = processor.parse(normalizeInput(markdown)) as MdastNode
  return tree.children?.flatMap(rootBlockFromNode) ?? []
}
