import type { ReactNode } from 'react'

import { notionObjectUrl } from '@overeng/notion-effect-schema'

import type { RichTextItem } from '../renderer/flatten-rich-text.ts'
import { buildCandidateTree } from '../renderer/sync-diff.ts'
import type { CandidateNode, CandidateTree } from '../renderer/sync-diff.ts'

/**
 * Why a projected construct lost information on its way to Markdown. The body
 * is always produced; diagnostics describe what a reader must not assume is
 * losslessly represented.
 */
export type MarkdownDiagnosticKind =
  | 'unsupported-block'
  | 'media-without-url'
  | 'color-dropped'
  | 'flattened'

export interface MarkdownDiagnostic {
  readonly kind: MarkdownDiagnosticKind
  readonly message: string
}

export interface NotionMarkdownResult {
  readonly body: string
  readonly diagnostics: readonly MarkdownDiagnostic[]
}

interface WalkState {
  readonly diagnostics: MarkdownDiagnostic[]
}

const DEFAULT_CALLOUT_ICON = '\u2139\uFE0F'

const indentLines = ({ text, spaces }: { text: string; spaces: number }): string =>
  text
    .split('\n')
    .map((line) => (line === '' ? line : `${' '.repeat(spaces)}${line}`))
    .join('\n')

const quoteLines = (text: string): string =>
  text
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n')

const escapeTableCell = (text: string): string =>
  text.replaceAll('|', '\\|').replaceAll('\n', '<br>')

const escapeLinkLabel = (text: string): string => text.replaceAll('[', '\\[').replaceAll(']', '\\]')

// -----------------------------------------------------------------------------
// Inline rich text -> Markdown
// -----------------------------------------------------------------------------

const renderMention = (opts: {
  item: Extract<RichTextItem, { type: 'mention' }>
  state: WalkState
}): string => {
  const { item, state } = opts
  const mention = item.mention as Record<string, unknown>
  const plain = typeof item.plain_text === 'string' ? item.plain_text : ''
  switch (mention.type) {
    case 'user':
      return `@${plain}`
    case 'page':
    case 'database': {
      const href =
        typeof mention[mention.type] === 'object' && mention[mention.type] !== null
          ? (mention[mention.type] as { href?: unknown }).href
          : undefined
      return typeof href === 'string' ? `[${plain}](${href})` : plain
    }
    case 'date': {
      const date = (mention.date ?? {}) as { start?: unknown; end?: unknown }
      const start = typeof date.start === 'string' ? date.start : ''
      const end = typeof date.end === 'string' ? date.end : undefined
      return end !== undefined ? `${start} \u2192 ${end}` : start
    }
    case 'link_preview': {
      const url = (mention.link_preview as { url?: unknown } | undefined)?.url
      return typeof url === 'string' ? `[${plain}](${url})` : plain
    }
    default:
      state.diagnostics.push({
        kind: 'unsupported-block',
        message: `mention of type ${String(mention.type)} rendered as plain text`,
      })
      return plain
  }
}

const renderInlineItem = (opts: { item: RichTextItem; state: WalkState }): string => {
  const { item, state } = opts
  if (item.type === 'equation') return `$${item.equation.expression}$`
  if (item.type === 'mention') return renderMention({ item, state })

  const [, leading = '', core = '', trailing = ''] =
    item.text.content.match(/^(\s*)([\s\S]*?)(\s*)$/) ?? []
  if (core === '') return item.text.content

  const ann = item.annotations
  if (ann.color !== 'default') {
    state.diagnostics.push({ kind: 'color-dropped', message: `text color ${ann.color} dropped` })
  }
  let wrapped = core
  if (ann.bold === true) wrapped = `**${wrapped}**`
  if (ann.italic === true) wrapped = `*${wrapped}*`
  if (ann.strikethrough === true) wrapped = `~~${wrapped}~~`
  if (ann.code === true) wrapped = `\`${wrapped}\``
  if (ann.underline === true) wrapped = `<u>${wrapped}</u>`

  const withAnnotations = `${leading}${wrapped}${trailing}`
  return item.text.link === null ? withAnnotations : `[${withAnnotations}](${item.text.link.url})`
}

const renderRichText = (opts: { items: readonly RichTextItem[]; state: WalkState }): string =>
  opts.items.map((item) => renderInlineItem({ item, state: opts.state })).join('')

/** Plain-text concatenation for contexts where Markdown annotations must not apply (code fences). */
const renderPlainText = (items: readonly RichTextItem[]): string =>
  items
    .map((item) => {
      if (item.type === 'text') return item.text.content
      if (item.type === 'equation') return item.equation.expression
      return typeof item.plain_text === 'string' ? item.plain_text : ''
    })
    .join('')

// -----------------------------------------------------------------------------
// Block tree -> Markdown
// -----------------------------------------------------------------------------

const renderUrlBlock = (opts: { node: CandidateNode; state: WalkState }): string => {
  const { node, state } = opts
  const captionItems = Array.isArray(node.props.caption)
    ? (node.props.caption as RichTextItem[])
    : []
  const caption = renderRichText({ items: captionItems, state })
  const url = typeof node.props.url === 'string' ? node.props.url : undefined

  if (url === undefined && node.props.file_upload !== undefined) {
    const id = (node.props.file_upload as { id?: unknown }).id
    state.diagnostics.push({
      kind: 'media-without-url',
      message: `${node.type} references file_upload ${String(id)} which has no resolvable URL offline`,
    })
    return `<!-- ${node.type}: unresolvable upload ${String(id)} -->`
  }
  if (url === undefined) {
    const external = (node.props.external as { url?: unknown } | undefined)?.url
    if (typeof external !== 'string') {
      state.diagnostics.push({
        kind: 'media-without-url',
        message: `${node.type} has no source URL`,
      })
      return `<!-- ${node.type}: missing source -->`
    }
    return renderResolvedUrl({ type: node.type, url: external, caption })
  }
  return renderResolvedUrl({ type: node.type, url, caption })
}

const renderResolvedUrl = (opts: { type: string; url: string; caption: string }): string => {
  const { type, url, caption } = opts
  const label = caption !== '' ? escapeLinkLabel(caption) : null
  switch (type) {
    case 'image':
      return `![${label ?? ''}](${url})`
    case 'video':
      return `[${label ?? 'Video'}](${url})`
    case 'audio':
      return `[${label ?? 'Audio'}](${url})`
    case 'pdf':
      return `[${label ?? 'PDF'}](${url})`
    case 'file':
      return `[${label ?? 'File'}](${url})`
    case 'bookmark':
      return `[${label ?? url}](${url})`
    case 'embed':
      return `[${label ?? 'Embed'}](${url})`
    default:
      return `[${label ?? type}](${url})`
  }
}

const renderTable = (opts: { node: CandidateNode; state: WalkState }): string => {
  const rows = opts.node.children.filter((child) => child.type === 'table_row')
  if (rows.length === 0) return ''
  const cellsOf = (row: CandidateNode): string[] => {
    const cells = Array.isArray(row.props.cells) ? (row.props.cells as RichTextItem[][]) : []
    return cells.map((cell) => escapeTableCell(renderRichText({ items: cell, state: opts.state })))
  }
  const firstRow = cellsOf(rows[0]!)
  const columnCount = Math.max(...rows.map((row) => cellsOf(row).length))
  const pad = (cells: string[]): string[] => {
    const padded = [...cells]
    while (padded.length < columnCount) padded.push('')
    return padded
  }
  const hasColumnHeader = opts.node.props.has_column_header !== false
  const header = pad(
    hasColumnHeader
      ? firstRow
      : columnCount > 0
        ? Array.from({ length: columnCount }, () => '')
        : [],
  )
  const bodyRows = (hasColumnHeader ? rows.slice(1) : rows).map((row) => pad(cellsOf(row)))
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...bodyRows.map((row) => `| ${row.join(' | ')} |`),
  ]
  return lines.join('\n')
}

const unsupportedPlaceholder = (opts: {
  node: CandidateNode
  reason: string
  state: WalkState
}): string => {
  opts.state.diagnostics.push({
    kind: 'unsupported-block',
    message: `${opts.node.type} block emitted as placeholder (${opts.reason})`,
  })
  return `<!-- unsupported block: ${opts.node.type} -->`
}

/**
 * Render one candidate node to an UNINDENTED Markdown fragment. Parents apply
 * indentation when embedding fragments under list markers or quotes.
 */
const renderNode = (opts: {
  node: CandidateNode
  ordinal: number | undefined
  state: WalkState
}): string => {
  const { node, ordinal, state } = opts
  const props = node.props
  const children = (nodes: readonly CandidateNode[], spaces: number): string => {
    const parts = renderNodes({ nodes, state })
    return parts.length === 0 ? '' : indentLines({ text: parts.join('\n\n'), spaces })
  }

  const richText = Array.isArray(props.rich_text) ? (props.rich_text as RichTextItem[]) : []

  switch (node.type) {
    case 'paragraph':
      return renderRichText({ items: richText, state })
    case 'heading_1':
    case 'heading_2':
    case 'heading_3':
    case 'heading_4': {
      const level = Number(node.type.slice(-1))
      const heading = `${'#'.repeat(level)} ${renderRichText({ items: richText, state })}`
      if (props.is_toggleable === true && node.children.length > 0) {
        state.diagnostics.push({
          kind: 'flattened',
          message: `toggleable heading rendered as flat heading + following content`,
        })
        return [heading, renderNodes({ nodes: node.children, state }).join('\n\n')].join('\n\n')
      }
      if (props.color !== undefined) {
        state.diagnostics.push({
          kind: 'color-dropped',
          message: `heading color ${String(props.color)} dropped`,
        })
      }
      return heading
    }
    case 'bulleted_list_item': {
      const marker = '- '
      const nested = children(node.children, marker.length)
      return nested === ''
        ? `${marker}${renderRichText({ items: richText, state })}`
        : `${marker}${renderRichText({ items: richText, state })}\n${nested}`
    }
    case 'numbered_list_item': {
      const n = ordinal ?? 1
      const marker = `${n}. `
      const nested = children(node.children, marker.length)
      return nested === ''
        ? `${marker}${renderRichText({ items: richText, state })}`
        : `${marker}${renderRichText({ items: richText, state })}\n${nested}`
    }
    case 'to_do': {
      const checkbox = props.checked === true ? '[x]' : '[ ]'
      const marker = `- ${checkbox} `
      const nested = children(node.children, marker.length)
      return nested === ''
        ? `${marker}${renderRichText({ items: richText, state })}`
        : `${marker}${renderRichText({ items: richText, state })}\n${nested}`
    }
    case 'toggle': {
      const title = renderRichText({ items: richText, state })
      const inner = renderNodes({ nodes: node.children, state })
      return inner.length === 0
        ? `<details>\n<summary>${title}</summary>\n</details>`
        : `<details>\n<summary>${title}</summary>\n\n${inner.join('\n\n')}\n\n</details>`
    }
    case 'quote':
    case 'callout': {
      let prefix = ''
      if (node.type === 'callout') {
        const icon = (props.icon as { emoji?: unknown } | undefined)?.emoji
        prefix = typeof icon === 'string' ? `${icon} ` : `${DEFAULT_CALLOUT_ICON} `
        if (props.color !== undefined) {
          state.diagnostics.push({
            kind: 'color-dropped',
            message: `callout color ${String(props.color)} dropped`,
          })
        }
      }
      const own = quoteLines(`${prefix}${renderRichText({ items: richText, state })}`)
      const nested = children(node.children, 0)
      return nested === '' ? own : `${own}\n${quoteLines(nested)}`
    }
    case 'code':
      return `\`\`\`${typeof props.language === 'string' ? props.language : ''}\n${renderPlainText(richText)}\n\`\`\``
    case 'divider':
      return '---'
    case 'equation':
      return `$$\n${typeof props.expression === 'string' ? props.expression : ''}\n$$`
    case 'table_of_contents':
      return '[TOC]'
    case 'image':
    case 'video':
    case 'audio':
    case 'file':
    case 'pdf':
    case 'bookmark':
    case 'embed':
      return renderUrlBlock({ node, state })
    case 'link_to_page':
      return `[Link to page](${notionObjectUrl(typeof props.page_id === 'string' ? props.page_id : '')})`
    case 'table':
      return renderTable({ node, state })
    case 'column_list':
      state.diagnostics.push({
        kind: 'flattened',
        message: 'column layout flattened to sequential blocks',
      })
      return renderNodes({ nodes: node.children, state }).join('\n\n')
    case 'column':
      return renderNodes({ nodes: node.children, state }).join('\n\n')
    default: {
      if (node.nodeKind === 'page') {
        const title = typeof props.title === 'string' ? props.title : 'Untitled'
        state.diagnostics.push({
          kind: 'flattened',
          message: `child page boundary flattened: "${title}" rendered as bold label + inline content`,
        })
        const inner = renderNodes({ nodes: node.children, state })
        const label = `**${title}** (child page)`
        return inner.length === 0 ? label : `${label}\n\n${inner.join('\n\n')}`
      }
      if (richText.length > 0 || props.template !== undefined) {
        const own = renderRichText({ items: richText, state })
        const inner = renderNodes({ nodes: node.children, state })
        state.diagnostics.push({
          kind: 'unsupported-block',
          message: `${node.type} block rendered generically from rich_text`,
        })
        return inner.length === 0
          ? own
          : [own, inner.join('\n\n')].filter((s) => s !== '').join('\n\n')
      }
      return unsupportedPlaceholder({ node, reason: 'no Markdown spelling', state })
    }
  }
}

const renderNodes = (opts: { nodes: readonly CandidateNode[]; state: WalkState }): string[] => {
  const out: string[] = []
  let previousWasNumbered = false
  let counter = 0
  for (const node of opts.nodes) {
    let ordinal: number | undefined
    if (node.type === 'numbered_list_item') {
      counter = previousWasNumbered ? counter + 1 : 1
      ordinal = counter
      previousWasNumbered = true
    } else {
      previousWasNumbered = false
    }
    const md = renderNode({ node, ordinal, state: opts.state })
    if (md !== '') out.push(md)
  }
  return out
}

/**
 * Project authored JSX through the same normalized render/tree pass that feeds
 * Notion projection, then serialize the resulting candidate tree to a readable
 * Notion-enhanced-Markdown body. Pure, synchronous, and network-free.
 *
 * Read-only by contract: nothing here mutates Notion and no cache is read or
 * written. Constructs that cannot survive the projection emit diagnostics
 * instead of disappearing silently.
 *
 * @experimental Experimental surface (#1097): spellings and the diagnostics
 * contract may change until a real consumer (Blocky preview/export) has proven
 * the output and the fidelity matrix is complete. Do not treat the body as a
 * canonical Notion round-trip representation.
 */
export const renderToNotionMarkdown = (element: ReactNode): NotionMarkdownResult => {
  const tree: CandidateTree = buildCandidateTree(element, '__markdown__')
  const state: WalkState = { diagnostics: [] }
  const parts = renderNodes({ nodes: tree.children, state })
  return { body: parts.join('\n\n'), diagnostics: state.diagnostics }
}
