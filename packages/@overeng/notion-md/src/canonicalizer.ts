import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import { unified } from 'unified'
import { visit } from 'unist-util-visit'

import { sha256Digest } from './hash.ts'

/*
 * The R33 semantic-equivalence keystone (DQ-VNEXT-1).
 *
 * "In sync" must mean semantic equivalence under a specified canonical
 * normalization applied IDENTICALLY to both sides — not byte-equality. This
 * pure module is that normalization. `status` and `sync` share it verbatim, so
 * the safe preview and the apply can never disagree on what "in sync" means.
 *
 * The normalization runs over the block-tree-rendered body (not raw lossy
 * endpoint markdown) and folds presentation-only differences while preserving
 * every semantic/block-type distinction.
 *
 * FOLDED (presentation-only — cosmetically different, semantically equal):
 *
 * - emphasis-marker choice (`*`↔`_`, `**`↔`__`) — remark restringifies both to
 *   one marker set.
 * - ordered-list renumbering (`2.`/`3.`→`1.`/`2.` resequencing) — the start
 *   ordinal is reset to 1; ITEM ORDER is preserved.
 * - loose-vs-tight list spacing — both restringify to tight.
 * - table-alignment/padding whitespace — remark recomputes cell padding.
 * - trailing-whitespace and trailing-space "hard breaks" — folded to a single
 *   space (a soft join), since Notion does not round-trip them as breaks.
 * - blank-line-run collapse — remark emits exactly one blank line between
 *   blocks.
 *
 * NOT FOLDED (semantic — must stay distinct; these are the #756/#759/#763
 * shapes the fidelity corpus guards):
 *
 * - heading level (`#` vs `##`) and heading-vs-paragraph type.
 * - paragraph-vs-heading ADJACENCY (a paragraph after a list vs an item).
 * - divider presence.
 * - code-fence language.
 * - list ORDINAL ORDER (item sequence — only the start ordinal is folded).
 *
 * The relation is equality of the canonical normal form, hence reflexive,
 * symmetric, and transitive by construction.
 */

/**
 * remark transform applying the DQ-1 fold set that is NOT already covered by
 * the stringify options below (emphasis/strong markers, table padding,
 * blank-line runs are stringify-level; these need AST edits).
 */
const foldPresentationOnly: () => (tree: unknown) => void = () => (tree) => {
  /*
   * Ordered-list renumber: reset the start ordinal to 1 so `2.`-led and
   * `1.`-led lists with the same items compare equal. Item ORDER is untouched.
   * Loose↔tight: force every list and item tight (spread: false), so a
   * blank-line-separated list folds to the compact form.
   */
  visit(
    tree as never,
    'list',
    (node: {
      ordered?: boolean
      start?: number
      spread?: boolean
      children?: Array<{ spread?: boolean }>
    }) => {
      if (node.ordered === true) node.start = 1
      node.spread = false
      if (Array.isArray(node.children) === true) {
        for (const item of node.children) item.spread = false
      }
    },
  )

  /*
   * Trailing-space / backslash hard breaks: Notion does not preserve a hard
   * break inside a paragraph as a distinct break, so fold it to a single space
   * (a soft join) on both sides rather than letting one side carry a `break`.
   */
  visit(
    tree as never,
    'break',
    (_node: unknown, index: number | undefined, parent: { children: unknown[] } | undefined) => {
      if (parent !== undefined && index !== undefined) {
        parent.children[index] = { type: 'text', value: ' ' }
      }
    },
  )

  /*
   * Soft line breaks inside a paragraph (a literal `\n` in source) render as
   * hard breaks on Notion; collapse them to single spaces so a logical
   * paragraph survives as one block on both sides.
   */
  visit(tree as never, 'text', (node: { value: string }) => {
    if (node.value.includes('\n') === true) {
      node.value = node.value.replace(/[ \t]*\n[ \t]*/g, ' ')
    }
  })
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(foldPresentationOnly)
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

/**
 * Reduce a block-tree-rendered Markdown body to its canonical normal form (the
 * R33 oracle). Idempotent: `canonicalize(canonicalize(x)) === canonicalize(x)`.
 */
export const canonicalize = (markdown: string): string => {
  const normalized = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const rendered = processor.processSync(normalized).toString()
  return rendered.endsWith('\n') === true ? rendered : `${rendered}\n`
}

/**
 * The R33 equivalence relation: two bodies are in sync iff their canonical
 * normal forms are byte-equal. Reflexive/symmetric/transitive by construction
 * (it is `===` over the normal form).
 */
export const semanticEqual = (opts: { readonly a: string; readonly b: string }): boolean =>
  canonicalize(opts.a) === canonicalize(opts.b)

/**
 * Stable content identity of a body under the R33 relation — the hash of its
 * canonical normal form. Two semantically-equal bodies share one hash, so this
 * is the noop oracle for the stateless reconcile core.
 */
export const canonicalHash = (markdown: string): string => sha256Digest(canonicalize(markdown))
