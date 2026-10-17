import type { ReactNode, ReactElement } from 'react'

/**
 * Projected Notion `rich_text[]` entry. Structurally compatible with the
 * Notion API; we keep it locally typed so the renderer doesn't need to import
 * the full Effect schemas at runtime.
 */
export type RichTextItem =
  | {
      readonly type: 'text'
      readonly text: { readonly content: string; readonly link: { readonly url: string } | null }
      readonly annotations: Annotations
    }
  | {
      readonly type: 'mention'
      readonly mention: Record<string, unknown>
      readonly plain_text?: string
      readonly annotations: Annotations
    }
  | {
      readonly type: 'equation'
      readonly equation: { readonly expression: string }
      readonly annotations: Annotations
    }

export type Annotations = {
  readonly bold: boolean
  readonly italic: boolean
  readonly strikethrough: boolean
  readonly underline: boolean
  readonly code: boolean
  readonly color: string
}

const defaultAnnotations: Annotations = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: 'default',
}

/**
 * Brand attached to inline annotation components so the flattener can
 * identify them without relying on displayName or referential identity
 * (which breaks across module duplication).
 */
export const INLINE_TAG = Symbol.for('@overeng/notion-react/inline')

export type InlineTag =
  | { readonly kind: 'annotation'; readonly patch: Partial<Annotations> }
  | { readonly kind: 'link'; readonly url: string }
  | {
      readonly kind: 'mention'
      readonly mention: Record<string, unknown>
      readonly plainText?: string
    }
  | { readonly kind: 'equation'; readonly expression: string }

/**
 * Inline component brand. The tag may be a static value (e.g. Bold) or a
 * function that derives the tag from the element's props (e.g. Link, Mention,
 * InlineEquation).
 */
export type InlineComponent = ((props: { children?: ReactNode }) => ReactNode) & {
  readonly [INLINE_TAG]: InlineTag | ((props: Record<string, unknown>) => InlineTag)
}

const isReactElement = (node: unknown): node is ReactElement<{ children?: ReactNode }> =>
  typeof node === 'object' &&
  node !== null &&
  '$$typeof' in node &&
  'type' in node &&
  'props' in node

const getInlineTag = (el: ReactElement): InlineTag | undefined => {
  const type = el.type as unknown
  if (typeof type !== 'function') return undefined
  const raw = (type as Partial<InlineComponent>)[INLINE_TAG]
  if (raw === undefined) return undefined
  return typeof raw === 'function' ? raw(el.props as Record<string, unknown>) : raw
}

/**
 * Notion API hard-limits each `rich_text` `text` segment to 2000 characters.
 * Longer content must be split into multiple items sharing the same annotation
 * frame and link envelope. The value is JS code-unit based (matches Notion's
 * validation), so we count UTF-16 code units here, not grapheme clusters.
 */
export const RICH_TEXT_MAX_LEN = 2000

/**
 * Split a string into chunks of ≤`max` UTF-16 code units. We avoid splitting
 * a surrogate pair in half; for grapheme boundaries inside the BMP we use
 * `Intl.Segmenter` when available and the break sits within the tail ≥64
 * code units (cheap prefix, avoids scanning huge strings). Otherwise we
 * fall back to a code-unit split with surrogate-safety.
 *
 * This is called per flat `text` emission, so it handles the giant-URL case
 * too — any single run longer than `max` yields a contiguous chunk list.
 */
const splitIntoChunks = (s: string, max: number): string[] => {
  if (s.length <= max) return [s]
  const chunks: string[] = []
  let i = 0
  while (i < s.length) {
    let end = Math.min(i + max, s.length)
    // Avoid splitting a surrogate pair. If the break is between a high and
    // low surrogate, pull back by one code unit.
    if (end < s.length) {
      const prev = s.charCodeAt(end - 1)
      if (prev >= 0xd800 && prev <= 0xdbff) end -= 1
    }
    chunks.push(s.slice(i, end))
    i = end
  }
  return chunks
}

const emitText = (
  items: RichTextItem[],
  content: string,
  link: { url: string } | null,
  ann: Annotations,
): void => {
  for (const chunk of splitIntoChunks(content, RICH_TEXT_MAX_LEN)) {
    items.push({ type: 'text', text: { content: chunk, link }, annotations: ann })
  }
}

/**
 * Walk a React node tree and flatten it into Notion `rich_text[]`.
 *
 * - Plain strings/numbers become `text` items carrying the current annotation frame.
 * - Inline annotation components (Bold, Italic, ...) merge their patch into the frame.
 * - Link wraps into `text.link`.
 * - Mention and Equation produce their respective leaves.
 * - Unknown element types are rendered as their (flattened) children.
 * - Text content >`RICH_TEXT_MAX_LEN` is split into multiple `text` items that
 *   share the annotation+link envelope (Notion API segment-length limit).
 */
export const flattenRichText = (children: ReactNode): RichTextItem[] => {
  const items: RichTextItem[] = []
  const walk = (node: ReactNode, ann: Annotations, link: { url: string } | null): void => {
    if (node == null || node === false || node === true) return
    if (typeof node === 'string' || typeof node === 'number') {
      emitText(items, String(node), link, ann)
      return
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child, ann, link)
      return
    }
    if (!isReactElement(node)) return
    const tag = getInlineTag(node)
    if (tag === undefined) {
      // Recurse through React Fragments (including keyed fragments) so
      // patterns like `<Paragraph><>hello</></Paragraph>` don't silently
      // drop the inner text. Fragments are symbol-typed, distinct from
      // both host block elements (string-typed, e.g. `"paragraph"`) and
      // block components (function-typed, e.g. `Paragraph`). Those two
      // *must not* recurse into the current rich_text frame — they're
      // reconciled as fibers instead.
      if (typeof node.type === 'symbol') walk(node.props.children, ann, link)
      return
    }
    const kids = node.props.children
    switch (tag.kind) {
      case 'annotation': {
        walk(kids, { ...ann, ...tag.patch }, link)
        return
      }
      case 'link': {
        walk(kids, ann, { url: tag.url })
        return
      }
      case 'mention': {
        items.push({
          type: 'mention',
          mention: tag.mention,
          ...(tag.plainText === undefined ? {} : { plain_text: tag.plainText }),
          annotations: ann,
        })
        return
      }
      case 'equation': {
        items.push({ type: 'equation', equation: { expression: tag.expression }, annotations: ann })
        return
      }
    }
  }
  walk(children, defaultAnnotations, null)
  return items
}
