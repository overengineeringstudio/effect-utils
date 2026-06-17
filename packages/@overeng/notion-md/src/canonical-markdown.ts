import { canonicalizeBlockMarkdown } from '@overeng/notion-effect-client'

/*
 * `canonicalizeBlockMarkdown` — the single canonical body form — now lives in
 * `@overeng/notion-effect-client`, beside the renderer (`treeToMarkdown`) and
 * the media-URL canonicalizer it calls, so the canonical body is produced where
 * the bytes originate (decision 0019). This module keeps only `semanticEquivalent`,
 * which is sync *policy* (the push integrity gate), not the wire form itself.
 */
export {
  canonicalizeBlockMarkdown,
  canonicalizeSemanticMarkdown,
} from '@overeng/notion-effect-client'

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

/**
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
export const semanticEquivalent = (opts: { readonly a: string; readonly b: string }): boolean => {
  const compact = (s: string): string =>
    splitFences(canonicalizeBlockMarkdown(s))
      .map((segment) =>
        segment.kind === 'code' ? segment.content : segment.content.replace(/\s+/gu, ' ').trim(),
      )
      .join('\n')
      .trim()
  return compact(opts.a) === compact(opts.b)
}
