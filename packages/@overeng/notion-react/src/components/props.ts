import type { ReactNode } from 'react'

/**
 * Shared prop-shape definitions for every Notion block / inline component.
 *
 * Both the Notion-host components in `./blocks.tsx` / `./inline.tsx` and the
 * DOM components in `../web/` consume these types so a drift in one output
 * surface shows up as a type error in the other.
 */

type Children = { readonly children?: ReactNode }

/**
 * Renderer-level identity hint. When provided on a block-producing component,
 * the reconciler uses it for stable diffing across renders instead of falling
 * back to positional keys. Never projected to the Notion payload.
 */
type BlockKey = { readonly blockKey?: string }

export type PageProps = Children

export type ParagraphProps = Children

export type HeadingProps = Children & BlockKey & { readonly toggleable?: boolean }

export type BulletedListItemProps = Children
export type NumberedListItemProps = Children

export type ToDoProps = Children & { readonly checked?: boolean }

export type ToggleProps = Children & BlockKey & { readonly title?: string }

export type CodeProps = Children & { readonly language?: string }

export type QuoteProps = Children

/**
 * Notion accepts two icon envelopes on callouts: a bare emoji or an external
 * file URL. The component surface mirrors this: pass a string for the emoji
 * case, or `{ external: url }` for the external-image case.
 */
export type CalloutIcon = string | { readonly external: string }

export type CalloutProps = Children &
  BlockKey & {
    readonly icon?: CalloutIcon
    readonly color?: string
  }

export type DividerProps = Record<string, never>

export type MediaProps = {
  readonly url?: string
  readonly src?: string
  readonly fileUploadId?: string
  readonly caption?: ReactNode
}

export type BookmarkProps = { readonly url: string }
export type EmbedProps = { readonly url: string }

export type EquationProps = { readonly expression: string }

export type TableProps = Children & {
  readonly tableWidth?: number
  readonly hasColumnHeader?: boolean
  readonly hasRowHeader?: boolean
}
export type TableRowProps = { readonly cells: readonly ReactNode[] }
export type ColumnListProps = Children
export type ColumnProps = Children & { readonly widthRatio?: number }

export type LinkToPageProps = { readonly pageId: string }
export type TableOfContentsProps = Record<string, never>
export type ChildPageProps = { readonly title?: string }

export type RawProps<TType extends string = string> = {
  readonly type: TType
  readonly content: unknown
}

export type PassthroughProps = { readonly content: unknown }
export type BreadcrumbProps = { readonly content?: unknown }

// Inline components ---------------------------------------------------------

export type InlineAnnotationProps = Children
export type ColorProps = Children & { readonly value: string }
export type TextProps = Children
export type LinkProps = Children & { readonly href: string }
export type MentionProps = Children & {
  readonly mention: Record<string, unknown>
  readonly plainText?: string
}
export type InlineEquationProps = Children & { readonly expression: string }
