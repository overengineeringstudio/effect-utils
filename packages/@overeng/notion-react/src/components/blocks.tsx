import { h } from './h.ts'
import type {
  BookmarkProps,
  BreadcrumbProps,
  BulletedListItemProps,
  CalloutProps,
  ChildPageProps,
  CodeProps,
  ColumnListProps,
  ColumnProps,
  EmbedProps,
  EquationProps,
  HeadingProps,
  LinkToPageProps,
  MediaProps,
  NumberedListItemProps,
  PageProps,
  ParagraphProps,
  PassthroughProps,
  QuoteProps,
  RawProps,
  TableProps,
  TableRowProps,
  ToDoProps,
  ToggleProps,
} from './props.ts'

/**
 * 1:1 Notion block components.
 *
 * Each component is a thin wrapper around a host element whose tag matches
 * the Notion block type. Ergonomic props (e.g. `toggleable` on headings,
 * `checked` on to_do) are forwarded to the host where the reconciler
 * projects them via `blockProps`.
 *
 * Components for blocks that carry rich text accept arbitrary React
 * children; the renderer flattens those children to a Notion `rich_text[]`
 * via `flattenRichText` at commit time (see host-config.ts).
 *
 * Prop shapes live in `./props.ts` and are shared with the DOM mirrors in
 * `../web/blocks.tsx` so drift between the two surfaces is a type error.
 */

export const Page = ({ children }: PageProps) => <>{children}</>

export const Paragraph = ({ children }: ParagraphProps) => h('paragraph', null, children)

const heading =
  (tag: 'heading_1' | 'heading_2' | 'heading_3' | 'heading_4') =>
  ({ children, toggleable }: HeadingProps) =>
    h(tag, toggleable === undefined ? null : { toggleable }, children)
export const Heading1 = heading('heading_1')
export const Heading2 = heading('heading_2')
export const Heading3 = heading('heading_3')
export const Heading4 = heading('heading_4')

export const BulletedListItem = ({ children }: BulletedListItemProps) =>
  h('bulleted_list_item', null, children)
export const NumberedListItem = ({ children }: NumberedListItemProps) =>
  h('numbered_list_item', null, children)

export const ToDo = ({ children, checked }: ToDoProps) =>
  h('to_do', checked === undefined ? null : { checked }, children)

export const Toggle = ({ children, title }: ToggleProps) =>
  h('toggle', title === undefined ? null : { title }, children)

export const Code = ({ children, language }: CodeProps) =>
  h('code', language === undefined ? null : { language }, children)

export const Quote = ({ children }: QuoteProps) => h('quote', null, children)

export const Callout = ({ children, icon, color }: CalloutProps) => {
  const props: Record<string, unknown> = {}
  if (icon !== undefined) props.icon = icon
  if (color !== undefined) props.color = color
  return h('callout', props, children)
}

export const Divider = () => h('divider', null)

const mediaUrl = (p: MediaProps): string | undefined => p.url ?? p.src
const media = (tag: string) => (props: MediaProps) => {
  const url = mediaUrl(props)
  const bag: Record<string, unknown> = {}
  if (url !== undefined) bag.url = url
  if (props.fileUploadId !== undefined) bag.fileUploadId = props.fileUploadId
  if (props.caption !== undefined) bag.caption = props.caption
  return h(tag, Object.keys(bag).length === 0 ? null : bag)
}
export const Image = media('image')
export const Video = media('video')
export const Audio = media('audio')
export const File = media('file')
export const Pdf = media('pdf')

export const Bookmark = ({ url }: BookmarkProps) => h('bookmark', { url })
export const Embed = ({ url }: EmbedProps) => h('embed', { url })

export const Equation = ({ expression }: EquationProps) => h('equation', { expression })

export const Table = ({ children, tableWidth, hasColumnHeader, hasRowHeader }: TableProps) => {
  const props: Record<string, unknown> = {}
  if (tableWidth !== undefined) props.tableWidth = tableWidth
  if (hasColumnHeader !== undefined) props.hasColumnHeader = hasColumnHeader
  if (hasRowHeader !== undefined) props.hasRowHeader = hasRowHeader
  return h('table', props, children)
}
export const TableRow = ({ cells }: TableRowProps) => h('table_row', { cells })
export const ColumnList = ({ children }: ColumnListProps) => h('column_list', null, children)
export const Column = ({ children }: ColumnProps) => h('column', null, children)
export const LinkToPage = ({ pageId }: LinkToPageProps) => h('link_to_page', { pageId })
export const TableOfContents = () => h('table_of_contents', null)
export const ChildPage = ({ title }: ChildPageProps) =>
  h('child_page', title === undefined ? null : { title })

/**
 * Schema-typed passthrough for block types that do not yet have ergonomic
 * wrappers. The `content` prop is forwarded verbatim to the renderer and
 * emitted as an opaque payload for the chosen block `type`.
 *
 * TODO: remove once first-class components exist for the relevant types.
 */
export const Raw = <TType extends string>({ type, content }: RawProps<TType>) =>
  h(type, { content })

// Stubbed 1:1 components that currently pipe through `Raw`.
// TODO: replace each with a schema-driven ergonomic wrapper.
export const Template = ({ content }: PassthroughProps) => <Raw type="template" content={content} />
export const LinkPreview = ({ content }: PassthroughProps) => (
  <Raw type="link_preview" content={content} />
)
export const SyncedBlock = ({ content }: PassthroughProps) => (
  <Raw type="synced_block" content={content} />
)
export const ChildDatabase = ({ content }: PassthroughProps) => (
  <Raw type="child_database" content={content} />
)
export const Breadcrumb = ({ content = {} }: BreadcrumbProps) => (
  <Raw type="breadcrumb" content={content} />
)
