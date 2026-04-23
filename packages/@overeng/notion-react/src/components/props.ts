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

/**
 * Notion page icon envelope. `emoji` is a bare unicode glyph; `external` points
 * at a public URL; `custom_emoji` references a workspace-scoped custom emoji by
 * id. Shapes empirically verified in `tmp/notion-618/experiments/findings.md`.
 *
 * Note (A07): response shape may differ slightly from request shape (e.g. the
 * `file` vs `external` duality for uploaded files); downstream normalization
 * happens at the client layer, not here.
 */
export type PageIcon =
  | { readonly type: 'emoji'; readonly emoji: string }
  | { readonly type: 'external'; readonly external: { readonly url: string } }
  | { readonly type: 'custom_emoji'; readonly custom_emoji: { readonly id: string } }

/**
 * Notion page cover envelope. Narrower than {@link PageIcon}: emoji and
 * custom_emoji are not accepted on covers. `file_upload` references a Notion
 * Files-API-uploaded asset by id.
 */
export type PageCover =
  | { readonly type: 'external'; readonly external: { readonly url: string } }
  | { readonly type: 'file_upload'; readonly file_upload: { readonly id: string } }

/**
 * One rich-text span inside a Notion page title. Titles accept 1..N spans;
 * per A10, each span's `text.content` is capped at 2000 characters by the
 * Notion API. Annotations mirror the block-level rich_text envelope.
 */
export type PageTitleSpan = {
  readonly type: 'text'
  readonly text: {
    readonly content: string
    readonly link?: { readonly url: string } | null
  }
  readonly annotations?: {
    readonly bold?: boolean
    readonly italic?: boolean
    readonly strikethrough?: boolean
    readonly underline?: boolean
    readonly code?: boolean
    readonly color?: string
  }
}

/**
 * Ergonomic page-title prop: a plain string (projected as a single span) or an
 * explicit array of {@link PageTitleSpan}s for annotated/multi-span titles.
 */
export type PageTitle = string | readonly PageTitleSpan[]

export type PageProps = Children & {
  readonly title?: PageTitle
  readonly icon?: PageIcon
  readonly cover?: PageCover
}

export type ParagraphProps = Children & BlockKey

/**
 * Notion's block-level color enum. Foreground colors (e.g. `red`) tint the
 * text; `_background` variants tint the block's background instead. `default`
 * has no `_background` form in the Notion API. This union mirrors the 19 + 1
 * values accepted on `callout.color`, `heading_*.color`, and other block
 * color fields.
 */
export type NotionColor =
  | 'default'
  | 'gray'
  | 'brown'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'purple'
  | 'pink'
  | 'red'
  | 'gray_background'
  | 'brown_background'
  | 'orange_background'
  | 'yellow_background'
  | 'green_background'
  | 'blue_background'
  | 'purple_background'
  | 'pink_background'
  | 'red_background'

export type HeadingProps = Children &
  BlockKey & {
    readonly toggleable?: boolean
    /** Notion block color. Projected verbatim onto the `heading_*` payload. */
    readonly color?: NotionColor
  }

export type BulletedListItemProps = Children & BlockKey
export type NumberedListItemProps = Children & BlockKey

export type ToDoProps = Children & BlockKey & { readonly checked?: boolean }

export type ToggleProps = Children & BlockKey & { readonly title?: string }

export type CodeProps = Children & BlockKey & { readonly language?: string }

export type QuoteProps = Children & BlockKey

/**
 * Notion accepts two icon envelopes on callouts: a bare emoji or an external
 * file URL. The component surface mirrors this: pass a string for the emoji
 * case, or `{ external: url }` for the external-image case.
 */
export type CalloutIcon = string | { readonly external: string }

export type CalloutProps = Children &
  BlockKey & {
    readonly icon?: CalloutIcon
    /** Notion block color. Projected verbatim onto the `callout` payload. */
    readonly color?: NotionColor
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

export type TableProps = Children &
  BlockKey & {
    readonly tableWidth?: number
    readonly hasColumnHeader?: boolean
    readonly hasRowHeader?: boolean
  }
export type TableRowProps = { readonly cells: readonly ReactNode[] }
export type ColumnListProps = Children & BlockKey
export type ColumnProps = Children & BlockKey & { readonly widthRatio?: number }

export type LinkToPageProps = { readonly pageId: string }
export type TableOfContentsProps = Record<string, never>
export type ChildPageProps = {
  readonly title?: PageTitle
  readonly icon?: PageIcon
  readonly cover?: PageCover
  readonly children?: ReactNode
}

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
