import {
  gfmStrikethroughFromMarkdown,
  gfmStrikethroughToMarkdown,
} from 'mdast-util-gfm-strikethrough'
import { gfmTableFromMarkdown, gfmTableToMarkdown } from 'mdast-util-gfm-table'
import {
  gfmTaskListItemFromMarkdown,
  gfmTaskListItemToMarkdown,
} from 'mdast-util-gfm-task-list-item'
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough'
import { gfmTable } from 'micromark-extension-gfm-table'
import { gfmTaskListItem } from 'micromark-extension-gfm-task-list-item'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import { unified, type Processor } from 'unified'
import { visit } from 'unist-util-visit'

import { canonicalizeMediaUrlsInMarkdown } from './media-url.ts'

/*
 * Canonical Markdown serialization used as the wire and on-disk form.
 *
 * Why a canonical form: Notion's enhanced-Markdown endpoint reserializes any
 * pushed body into its own block model, so byte-equal roundtrips are not
 * achievable. We define one canonical shape (CommonMark + selected GFM,
 * paragraphs unwrapped onto a single logical line, ATX headings, hyphen list
 * bullets, tight lists) and normalize both push input and pull output to it. The
 * push-side guard then checks canonical equality instead of byte equality, and
 * the visible Notion page no longer shows hard breaks from soft-wrapped source
 * paragraphs.
 *
 * This lives beside the renderer (`treeToMarkdown`) and the media-URL
 * canonicalizer (`media-url.ts`) it calls, so the canonical body is produced
 * where the bytes originate: `body-observation` emits an already-canonical
 * `renderedMarkdown`, and the evidence fingerprint, the fidelity classifier,
 * pull, hash, and push all see the same canonical string (decision 0019).
 */

/*
 * Soft line breaks inside a paragraph (a literal `\n` in source) render as
 * hard line breaks on Notion. Collapse them to single spaces so a logical
 * paragraph survives as one Notion block. Authors who want a hard break must
 * use the explicit `break` node (two trailing spaces or a backslash).
 */
const unwrapSoftBreaks: () => (tree: unknown) => void = () => (tree) => {
  visit(tree as never, 'text', (node: { value: string }) => {
    if (node.value.includes('\n') === true) {
      node.value = node.value.replace(/[ \t]*\n[ \t]*/g, ' ')
    }
  })
}

/*
 * Treat authored hard-break syntax as cosmetic for the reconciliation oracle:
 * Notion's Markdown round-trip can lose the exact trailing-space/backslash
 * spelling, while the visible text remains the same logical paragraph.
 */
const foldHardBreaks: () => (tree: unknown) => void = () => (tree) => {
  visit(
    tree as never,
    'break',
    (_node: unknown, index: number | undefined, parent: { children?: unknown[] } | undefined) => {
      if (typeof index !== 'number' || parent?.children === undefined) return
      parent.children.splice(index, 1, { type: 'text', value: ' ' })
    },
  )
}

/** Normalize common code-fence language aliases to their long names. */
const normalizeCodeLanguages: () => (tree: unknown) => void = () => (tree) => {
  visit(tree as never, 'code', (node: { lang?: string | null }) => {
    if (node.lang === 'js') {
      node.lang = 'javascript'
    } else if (node.lang === 'ts') {
      node.lang = 'typescript'
    }
  })
}

/*
 * Force every list and list item tight (`spread = false`), so remark-stringify
 * emits a single `\n` (not a blank line) between consecutive items.
 *
 * The block-tree renderer (`treeToMarkdown`) joins every sibling block —
 * including consecutive list items — with `\n\n`, producing a *loose*
 * CommonMark list (a blank line between every bullet) plus a stray indented
 * blank line inside nested lists. `remark-stringify` preserves list tightness
 * from its input, so re-stringifying a loose list stays loose unless we flip
 * `spread` off here. This is the single place that owns list-tightness policy:
 * pull and push both route through `canonicalizeBlockMarkdown`, so the canonical
 * body is tight regardless of how the renderer joined the siblings.
 *
 * It only flips `spread`; it never removes the blank line *before* a following
 * non-list block (that boundary is structural, not list-internal), so a
 * paragraph after a list keeps its separating blank line.
 */
const forceTightLists: () => (tree: unknown) => void = () => (tree) => {
  visit(tree as never, (node: { type: string; spread?: boolean }) => {
    if (node.type === 'list' || node.type === 'listItem') {
      node.spread = false
    }
  })
}

/*
 * Ordered lists start at `1` in the semantic reconciliation form because
 * Notion normalizes visible ordinal labels during round-trip and the authored
 * start number is not a durable body identity signal.
 */
const normalizeOrderedListStarts: () => (tree: unknown) => void = () => (tree) => {
  visit(tree as never, 'list', (node: { ordered?: boolean; start?: number }) => {
    if (node.ordered === true) node.start = 1
  })
}

const markdownStringifyOptions = {
  bullet: '-',
  emphasis: '_',
  strong: '*',
  fence: '`',
  fences: true,
  listItemIndent: 'one',
  resourceLink: true,
  rule: '-',
  setext: false,
  tightDefinitions: true,
} as const

const pushProcessorData = <A>({
  data,
  key,
  extensions,
}: {
  data: Record<string, unknown>
  key: string
  extensions: ReadonlyArray<A>
}): void => {
  const current = (data[key] ??= []) as Array<A>
  current.push(...extensions)
}

/*
 * Use only the GFM constructs Notion-flavored Markdown needs here. The bundled
 * `remark-gfm` also enables autolink literals, which rewrites plain URL/email-
 * shaped text into angle autolinks (`https://x.y` -> `<https://x.y>`). That is
 * lossy for Notion preview-link text and makes edge cases like `0@.A`
 * non-idempotent (`<0@.A>` -> `<<0@.A>>`).
 */
const remarkNotionGfm = function (this: Processor): void {
  const data = this.data() as Record<string, unknown>
  pushProcessorData({
    data,
    key: 'micromarkExtensions',
    extensions: [gfmTable(), gfmTaskListItem(), gfmStrikethrough()],
  })
  pushProcessorData({
    data,
    key: 'fromMarkdownExtensions',
    extensions: [
      gfmTableFromMarkdown(),
      gfmTaskListItemFromMarkdown(),
      gfmStrikethroughFromMarkdown(),
    ],
  })
  pushProcessorData({
    data,
    key: 'toMarkdownExtensions',
    extensions: [gfmTableToMarkdown(), gfmTaskListItemToMarkdown(), gfmStrikethroughToMarkdown()],
  })
}

const processor = unified()
  .use(remarkParse)
  .use(remarkNotionGfm)
  .use(unwrapSoftBreaks)
  .use(forceTightLists)
  .use(remarkStringify, markdownStringifyOptions)

const parseOnlyProcessor = unified().use(remarkParse).use(remarkNotionGfm)

const semanticProcessor = unified()
  .use(remarkParse)
  .use(remarkNotionGfm)
  .use(unwrapSoftBreaks)
  .use(foldHardBreaks)
  .use(normalizeCodeLanguages)
  .use(forceTightLists)
  .use(normalizeOrderedListStarts)
  .use(remarkStringify, markdownStringifyOptions)

const normalizeInput = (markdown: string): string =>
  canonicalizeMediaUrlsInMarkdown(markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n'))

const ensureTrailingNewline = (markdown: string): string =>
  markdown.endsWith('\n') === true ? markdown : `${markdown}\n`

/**
 * Reduce arbitrary Markdown to the single canonical body form, applied at BOTH
 * Notion wire boundaries — pull receive and push send — so the body a consumer
 * reads (`cat` / `edit` / file sync), the body hashed, and the body pushed are
 * the same bytes (decision 0019). The steps, in order:
 *
 *   1. line-ending normalize (CRLF/CR → LF)
 *   2. hosted-media URL canonicalize (volatile signature/expiry query params
 *      stripped, decision 0007 / R36) via the same shared function the renderer
 *      uses, so a rotated signed URL compares equal across pulls
 *   3. remark parse + selected GFM (tables, task-list items, strikethrough;
 *      intentionally no autolink literals)
 *   4. `unwrapSoftBreaks` — collapse intra-paragraph soft breaks
 *   5. `forceTightLists` — `spread = false` on every list / list item
 *   6. remark-stringify (the config above)
 *   7. ensure a single trailing newline
 *
 * Spacing/tightness policy lives only here: the renderer emits parseable-not-
 * canonical Markdown (it joins blocks with `\n\n` so they stay distinct), and
 * this layer decides the canonical shape. The renderer joins must not be made
 * block-type-aware — that would re-split the policy across two serializers.
 */
export const canonicalizeBlockMarkdown = (markdown: string): string => {
  const rendered = processor.processSync(normalizeInput(markdown)).toString()
  return ensureTrailingNewline(rendered)
}

/**
 * Canonical form for semantic reconciliation, not for preserving authored wire
 * bytes. It starts from the same parser/stringifier policy as
 * {@link canonicalizeBlockMarkdown}, then folds Notion round-trip cosmetics that
 * do not change the visible body: hard-break spelling and common code-fence
 * language aliases, plus ordered-list start ordinals. Use this for
 * equality/hash oracles, not for writing a body back to disk.
 */
export const canonicalizeSemanticMarkdown = (markdown: string): string => {
  const rendered = semanticProcessor.processSync(normalizeInput(markdown)).toString()
  return ensureTrailingNewline(rendered)
}

/**
 * Parse Markdown into a mdast AST without stringifying.
 *
 * Uses the same GFM extension set (tables, task-list items, strikethrough) as
 * the canonical serializers but skips any transforms — the raw tree is returned
 * for consumers that walk the AST directly (e.g. markdown-to-blocks).
 */
export const parseNotionMarkdownAst = (markdown: string): unknown =>
  parseOnlyProcessor.runSync(parseOnlyProcessor.parse(normalizeInput(markdown)))
