import type { ReactNode } from 'react'

/**
 * Shared prop-shape definitions for every Notion block / inline component.
 *
 * Both the Notion-host components in `./blocks.tsx` / `./inline.tsx` and the
 * DOM components in `../web/` consume these types so a drift in one output
 * surface shows up as a type error in the other.
 */

type Children = { readonly children?: ReactNode }

export type PageProps = Children

export type ParagraphProps = Children

export type HeadingProps = Children & { readonly toggleable?: boolean }

export type BulletedListItemProps = Children
export type NumberedListItemProps = Children

export type ToDoProps = Children & { readonly checked?: boolean }

export type ToggleProps = Children & { readonly title?: string }

export type CodeProps = Children & { readonly language?: string }

export type QuoteProps = Children

export type CalloutProps = Children & {
  readonly icon?: string
  readonly color?: string
}

export type DividerProps = Record<string, never>

export type MediaProps = {
  readonly url?: string
  readonly src?: string
  readonly caption?: ReactNode
}

export type BookmarkProps = { readonly url: string }
export type EmbedProps = { readonly url: string }

export type EquationProps = { readonly expression: string }

export type TableProps = Children
export type TableRowProps = Children
export type ColumnListProps = Children
export type ColumnProps = Children

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
