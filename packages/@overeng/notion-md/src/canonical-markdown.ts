import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import { unified } from 'unified'
import { visit } from 'unist-util-visit'

/*
 * Canonical Markdown serialization used as the wire and on-disk form.
 *
 * Why a canonical form: Notion's enhanced-Markdown endpoint reserializes any
 * pushed body into its own block model, so byte-equal roundtrips are not
 * achievable. We define one canonical shape (CommonMark + GFM, paragraphs
 * unwrapped onto a single logical line, ATX headings, hyphen list bullets) and
 * normalize both push input and pull output to it. The push-side guard then
 * checks canonical equality instead of byte equality, and the visible Notion
 * page no longer shows hard breaks from soft-wrapped source paragraphs.
 */

/*
 * Soft line breaks inside a paragraph (a literal `\n` in source) render as
 * hard line breaks on Notion. Collapse them to single spaces so a logical
 * paragraph survives as one Notion block. Authors who want a hard break must
 * use the explicit `break` node (two trailing spaces or a backslash).
 */
const unwrapSoftBreaks = () => (tree: { children?: unknown[] }) => {
  visit(tree as never, 'text', (node: { value: string }) => {
    if (node.value.includes('\n')) {
      node.value = node.value.replace(/[ \t]*\n[ \t]*/g, ' ')
    }
  })
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(unwrapSoftBreaks)
  .use(remarkStringify, {
    bullet: '-',
    emphasis: '_',
    strong: '*',
    fence: '`',
    fences: true,
    listItemIndent: 'one',
    rule: '-',
    setext: false,
    tightDefinitions: true,
  })

/** Reduce arbitrary Markdown to the canonical form used for hashing and wire transfer. */
export const canonicalizeBlockMarkdown = (markdown: string): string => {
  const normalized = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const rendered = processor.processSync(normalized).toString()
  return rendered.endsWith('\n') ? rendered : `${rendered}\n`
}

/*
 * Loose semantic comparison for the post-push integrity check.
 *
 * Notion's enhanced-Markdown ingest collapses inter-block blank lines, so the
 * markdown it returns and the markdown we sent are not byte-equal even when
 * the push landed exactly as intended. A structural AST comparison would also
 * disagree, because without blank-line separators remark fuses adjacent
 * paragraphs into a single node on Notion's side. We therefore compare both
 * sides under whitespace-collapsed canonical form — same tokens in the same
 * order means "the page reflects the push." Any genuine content drift (lost
 * sentences, reordered blocks, wrong replacement) still fails this check.
 */
export const semanticEquivalent = (a: string, b: string): boolean => {
  const compact = (s: string): string =>
    canonicalizeBlockMarkdown(s).replace(/\s+/gu, ' ').trim()
  return compact(a) === compact(b)
}
