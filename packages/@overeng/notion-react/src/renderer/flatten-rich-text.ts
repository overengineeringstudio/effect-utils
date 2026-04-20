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
 * Walk a React node tree and flatten it into Notion `rich_text[]`.
 *
 * - Plain strings/numbers become `text` items carrying the current annotation frame.
 * - Inline annotation components (Bold, Italic, ...) merge their patch into the frame.
 * - Link wraps into `text.link`.
 * - Mention and Equation produce their respective leaves.
 * - Unknown element types are rendered as their (flattened) children.
 */
export const flattenRichText = (children: ReactNode): RichTextItem[] => {
  const items: RichTextItem[] = []
  const walk = (node: ReactNode, ann: Annotations, link: { url: string } | null): void => {
    if (node == null || node === false || node === true) return
    if (typeof node === 'string' || typeof node === 'number') {
      items.push({ type: 'text', text: { content: String(node), link }, annotations: ann })
      return
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child, ann, link)
      return
    }
    if (!isReactElement(node)) return
    const tag = getInlineTag(node)
    if (tag === undefined) {
      // Only inline-tagged components contribute to rich_text. Host elements
      // (e.g. `<Paragraph>`) and untagged wrappers are treated as block
      // children — reconciled as fibers instead of folded into rich_text.
      // This is what keeps nested blocks under list-ish / text-leaf parents
      // from being silently swallowed.
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
