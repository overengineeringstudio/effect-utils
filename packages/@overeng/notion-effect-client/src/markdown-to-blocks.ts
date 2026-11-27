import type {
  NotionBlockCreate,
  TableRowBlockCreate as NotionTableRowBlockCreate,
  TextAnnotationsCreate as NotionTextAnnotationsCreate,
  RichTextCreate as NotionRichTextCreate,
} from '@overeng/notion-effect-schema'

import { NotionColorSchema } from '@overeng/notion-effect-schema'
import { Schema } from 'effect'

import { normalizeMarkdownInput, parseNotionMarkdownAst } from './canonical-markdown.ts'

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
  readonly position?: { readonly start: { readonly offset?: number }; readonly end: { readonly offset?: number } }
}

interface RichTextContext extends NotionTextAnnotationsCreate {
  readonly link?: string
}

const emptyRichText: readonly NotionRichTextCreate[] = [{ type: 'text', text: { content: '' } }]

const normalizeMarkdownForBlocks = (markdown: string): string =>
  markdown.replace(/<br\s*\/?>\s*/giu, '  \n')

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

const normalizeSoftBreaks = (value: string): string => value.replace(/\r?\n/gu, ' ')

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

const decodeEntities = (value: string): string =>
  value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/giu, (entity) => {
    const named: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }
    if (entity.startsWith('&#') === false) return named[entity.toLowerCase()] ?? entity
    const code = entity.toLowerCase().startsWith('&#x')
      ? Number.parseInt(entity.slice(3, -1), 16)
      : Number.parseInt(entity.slice(2, -1), 10)
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\uFFFD'
  })

const attributes = (tag: string): Readonly<Record<string, string>> =>
  Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)]
    .map((match) => [match[1]!, decodeEntities(match[2] ?? match[3] ?? '')]))

const mentionFromTag = (tag: string, context: RichTextContext): NotionRichTextCreate | undefined => {
  const name = /^<mention-(page|database|user|date)\b/u.exec(tag)?.[1]
  const attrs = attributes(tag)
  const annotations = annotationsFromContext(context)
  const frame = annotations === undefined ? {} : { annotations }
  if (name === 'date' && attrs.start !== undefined) {
    return { type: 'mention', mention: { type: 'date', date: {
      start: attrs.start, end: attrs.end ?? null, time_zone: attrs.timeZone ?? attrs.timezone ?? attrs.time_zone ?? null,
    } }, ...frame }
  }
  const id = (attrs.id ?? attrs.url ?? '').match(/[\da-f]{8}-?[\da-f]{4}-?[\da-f]{4}-?[\da-f]{4}-?[\da-f]{12}/iu)?.[0]
  if (id === undefined) return undefined
  if (name === 'page') return { type: 'mention', mention: { type: 'page', page: { id } }, ...frame }
  if (name === 'database') return { type: 'mention', mention: { type: 'database', database: { id } }, ...frame }
  if (name === 'user') return { type: 'mention', mention: { type: 'user', user: { object: 'user', id } }, ...frame }
  return undefined
}

const richTextFromNodes = ({
  nodes,
  context = {},
}: {
  readonly nodes: readonly MarkdownNode[]
  readonly context?: RichTextContext
}): readonly NotionRichTextCreate[] => {
  const richText: NotionRichTextCreate[] = []

  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!
    if (node.type === 'html' && /^<mention-(page|database|user|date)\b/u.test(node.value ?? '')) {
      const tag = node.value ?? ''
      const mention = mentionFromTag(tag, context)
      if (mention !== undefined) {
        richText.push(mention)
        if (/\/>$/u.test(tag) === false && /<\/mention-[\w-]+>/u.test(tag) === false) {
          const name = /^<(mention-[\w-]+)/u.exec(tag)?.[1]
          while (index + 1 < nodes.length) {
            index++
            if (nodes[index]?.type === 'html' && nodes[index]?.value === `</${name}>`) break
          }
        }
        continue
      }
    }
    if (node.type === 'text') {
      if (node.value !== undefined && node.value.length > 0) {
        richText.push(textSegment({ content: normalizeSoftBreaks(node.value), context }))
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

const firstParagraphIndex = (node: MarkdownNode): number =>
  childrenOf(node).findIndex((child) => child.type === 'paragraph')

const richTextFromListItem = (node: MarkdownNode): readonly NotionRichTextCreate[] => {
  const paragraphIndex = firstParagraphIndex(node)
  const firstParagraph = childrenOf(node)[paragraphIndex]
  return firstParagraph === undefined
    ? emptyRichText
    : richTextFromNodes({ nodes: childrenOf(firstParagraph) })
}

const listItemChildren = (node: MarkdownNode): readonly NotionBlockCreate[] => {
  const paragraphIndex = firstParagraphIndex(node)
  return childrenOf(node).flatMap((child, index) =>
    index === paragraphIndex ? [] : blocksFromNodes([child]),
  )
}

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
  const children = listItemChildren(node)
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
  if (language === undefined || language.length === 0) return 'plain text'

  const normalized = language.toLowerCase()
  if (normalized === 'js' || normalized === 'jsx' || normalized === 'mjs' || normalized === 'cjs') {
    return 'javascript'
  }
  if (normalized === 'ts' || normalized === 'tsx' || normalized === 'mts' || normalized === 'cts') {
    return 'typescript'
  }

  return normalized
}

const quoteText = (node: MarkdownNode): readonly NotionRichTextCreate[] => {
  const firstParagraph = childrenOf(node).find((child) => child.type === 'paragraph')
  return firstParagraph === undefined
    ? emptyRichText
    : richTextFromNodes({ nodes: childrenOf(firstParagraph) })
}

const quoteChildren = (node: MarkdownNode): readonly NotionBlockCreate[] =>
  childrenOf(node).flatMap((child) => (child.type === 'paragraph' ? [] : blocksFromNodes([child])))

/** Enhanced block bodies use tabs for ownership, not Markdown code indentation. */
const unindentEnhanced = (body: string): string =>
  body.replace(/^\n/u, '').replace(/\n[ \t]*$/u, '').replace(/^\t/gmu, '')

const parsedNodes = (markdown: string): readonly MarkdownNode[] => {
  const tree = parseNotionMarkdownAst(markdown)
  if (isMarkdownNode(tree) === false) return []
  return childrenOf(tree).map((node) => {
    if (node.type !== 'html' || /^<mention-/u.test(node.value ?? '') === false) return node
    const inlineTree = parseNotionMarkdownAst(`x ${node.value ?? ''}`)
    if (isMarkdownNode(inlineTree) === false) return node
    const paragraph = childrenOf(inlineTree)[0]
    if (paragraph?.type !== 'paragraph') return node
    const inline = childrenOf(paragraph)
    return { ...paragraph, children: [
      ...(inline[0]?.type === 'text' ? [{ ...inline[0], value: inline[0].value?.slice(2) }] : []),
      ...inline.slice(1),
    ] }
  })
}


const enhancedBlock = (source: string): NotionBlockCreate | undefined => {
  const opening = /^<(callout|details|table)\b[^>]*>/u.exec(source)
  if (opening === null) return undefined
  const name = opening[1]!
  const attrs = attributes(opening[0])
  const body = source.slice(opening[0].length, source.lastIndexOf(`</${name}>`))
  if (name === 'table') {
    const rows = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gu)]
    const cells = rows.map((row) => [...row[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gu)]
      .map((cell) => richTextFromNodes({ nodes: parsedNodes(unindentEnhanced(cell[1]!)).flatMap((node) =>
        node.type === 'paragraph' ? childrenOf(node) : [node]) })))
    const width = Math.max(1, ...cells.map((row) => row.length))
    return { object: 'block', type: 'table', table: {
      table_width: width,
      has_column_header: attrs['header-row'] === 'true',
      has_row_header: attrs['header-column'] === 'true',
      children: cells.map((row) => ({ object: 'block', type: 'table_row', table_row: {
        cells: Array.from({ length: width }, (_unused, index) => row[index] ?? emptyRichText),
      } })),
    } }
  }
  const candidateColor = attrs.color?.replace(/_bg$/u, '_background')
  const color = Schema.is(NotionColorSchema)(candidateColor) ? candidateColor : undefined
  const colorProps = color === undefined ? {} : { color }
  if (name === 'details') {
    const summary = /<summary\b[^>]*>([\s\S]*?)<\/summary>/u.exec(body)
    const title = summary?.[1] ?? ''
    const children = markdownToBlocks(unindentEnhanced(summary === null ? body : body.slice(summary.index + summary[0].length)))
    return { object: 'block', type: 'toggle', toggle: withChildren({
      value: { rich_text: richTextFromNodes({ nodes: parsedNodes(title).flatMap(childrenOf) }), ...colorProps }, children,
    }) }
  }
  const nodes = parsedNodes(unindentEnhanced(body))
  const first = nodes[0]
  const rich_text = first?.type === 'paragraph' ? richTextFromNodes({ nodes: childrenOf(first) }) : emptyRichText
  const remaining = first?.type === 'paragraph' ? nodes.slice(1) : nodes
  return { object: 'block', type: 'callout', callout: withChildren({
    value: { rich_text, ...colorProps, ...(attrs.icon === undefined ? { icon: null } : { icon: { type: 'emoji' as const, emoji: attrs.icon } }) },
    children: blocksFromEnhancedNodes({ nodes: remaining, source: unindentEnhanced(body) }),
  }) }
}

const blocksFromEnhancedNodes = ({ nodes, source }: {
  readonly nodes: readonly MarkdownNode[]
  readonly source: string
}): readonly NotionBlockCreate[] => {
  const blocks: NotionBlockCreate[] = []
  for (const node of nodes) {
    const start = node.position?.start.offset
    const match = node.type === 'html' ? /^<(callout|details|table)\b/u.exec(node.value ?? '') : null
    if (match !== null && start !== undefined) {
      const tag = match[1]!
      const tags = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gu')
      tags.lastIndex = start
      let depth = 0
      const searchable = source.replace(/(`+)[\s\S]*?\1/gu, (literal) => ' '.repeat(literal.length))
      for (const token of searchable.matchAll(tags)) {
        depth += token[1] === '/' ? -1 : 1
        if (depth !== 0) continue
        const end = token.index + token[0].length
        const block = enhancedBlock(source.slice(start, end))
        if (block !== undefined) blocks.push(block)
        return [...blocks, ...markdownToBlocks(source.slice(end))]
      }
    }
    blocks.push(...blocksFromNodes([node]))
  }
  return blocks
}

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
 * Supports the CommonMark/GFM subset and native enhanced callout, table,
 * details/summary toggle, and page/database/user/date mention tags.
 * Return values are create/append payloads, not retrieved blocks.
 */
export const markdownToBlocks = (markdown: string): readonly NotionBlockCreate[] => {
  const source = normalizeMarkdownInput(normalizeMarkdownForBlocks(markdown))
  return blocksFromEnhancedNodes({ nodes: parsedNodes(source), source })
}
