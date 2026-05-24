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
const unwrapSoftBreaks: () => (tree: unknown) => void = () => (tree) => {
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
 * Split markdown into alternating non-code and fenced-code segments. Lets
 * the integrity check be lenient about whitespace outside fences while
 * keeping code-block content verbatim.
 */
const splitFences = (
  markdown: string,
): ReadonlyArray<{ readonly kind: 'text' | 'code'; readonly content: string }> => {
  const lines = markdown.split('\n')
  const segments: Array<{ kind: 'text' | 'code'; content: string }> = []
  let current: { kind: 'text' | 'code'; lines: string[] } = { kind: 'text', lines: [] }
  let inFence = false
  for (const line of lines) {
    const fenceBoundary = /^\s*```/u.test(line)
    if (fenceBoundary === true) {
      segments.push({ kind: current.kind, content: current.lines.join('\n') })
      inFence = !inFence
      current = { kind: inFence === true ? 'code' : 'text', lines: [line] }
      continue
    }
    current.lines.push(line)
  }
  segments.push({ kind: current.kind, content: current.lines.join('\n') })
  return segments
}

/*
 * Post-push integrity check: did Notion store what we sent?
 *
 * Both sides go through `canonicalizeBlockMarkdown` (paragraphs unwrapped,
 * GFM rules, hyphen bullets). We then collapse whitespace runs *outside*
 * fenced code blocks — Notion's enhanced-Markdown ingest drops inter-block
 * blank lines and may switch list-indent style on storage, so a strict
 * byte-equal check would fail every push of multi-block content. Inside a
 * fenced code block we compare verbatim, so a code-block indentation
 * change or any deliberate whitespace edit between code tokens still fails
 * this check. The earlier `replace(/\s+/gu, ' ')` implementation collapsed
 * all whitespace globally and would have masked those real diffs.
 */
export const semanticEquivalent = (a: string, b: string): boolean => {
  const compact = (s: string): string =>
    splitFences(canonicalizeBlockMarkdown(s))
      .map((segment) =>
        segment.kind === 'code' ? segment.content : segment.content.replace(/\s+/gu, ' ').trim(),
      )
      .join('\n')
      .trim()
  return compact(a) === compact(b)
}
