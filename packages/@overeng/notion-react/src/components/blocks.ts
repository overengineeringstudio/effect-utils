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
 *
 * Note: this file is `.ts` (no JSX literals) so that Node's
 * `--experimental-strip-types` can consume `src/mod.ts` directly for
 * source-level dogfooding.
 */

/**
 * Root page wrapper. Renders as a virtual `page_root` host node so the
 * reconciler can carry optional page-level metadata (title/icon/cover) — the
 * host-config detects `page_root` and folds its children into the sync
 * container's top-level instead of emitting a block op for the wrapper
 * itself. Unwrapped top-level blocks (no `<Page>`) continue to work.
 *
 * Note: root-page metadata update is wired in phase 3b (#618); props are
 * projected here so the host-config sees them when 3b lands.
 */
export const Page = (props: PageProps) => {
  const hostProps: Record<string, unknown> = {}
  if (props.title !== undefined) hostProps.title = props.title
  if (props.icon !== undefined) hostProps.icon = props.icon
  if (props.cover !== undefined) hostProps.cover = props.cover
  return h('page_root', Object.keys(hostProps).length === 0 ? null : hostProps, props.children)
}

/**
 * Helper: emit a `blockKey`-only props bag when it's set, else `null`
 * so unkeyed components continue to produce a clean `{}`-free payload.
 * `blockKey` is a renderer identity hint, never projected to Notion.
 */
const keyedProps = (blockKey: string | undefined): Record<string, unknown> | null =>
  blockKey === undefined ? null : { blockKey }

export const Paragraph = ({ children, blockKey }: ParagraphProps) =>
  h('paragraph', keyedProps(blockKey), children)

const heading =
  (tag: 'heading_1' | 'heading_2' | 'heading_3' | 'heading_4') =>
  ({ children, toggleable, color, blockKey }: HeadingProps) => {
    const props: Record<string, unknown> = {}
    if (toggleable !== undefined) props.toggleable = toggleable
    if (color !== undefined) props.color = color
    if (blockKey !== undefined) props.blockKey = blockKey
    return h(tag, Object.keys(props).length === 0 ? null : props, children)
  }
export const Heading1 = heading('heading_1')
export const Heading2 = heading('heading_2')
export const Heading3 = heading('heading_3')
export const Heading4 = heading('heading_4')

export const BulletedListItem = ({ children, blockKey }: BulletedListItemProps) =>
  h('bulleted_list_item', keyedProps(blockKey), children)
export const NumberedListItem = ({ children, blockKey }: NumberedListItemProps) =>
  h('numbered_list_item', keyedProps(blockKey), children)

export const ToDo = ({ children, checked, blockKey }: ToDoProps) => {
  const props: Record<string, unknown> = {}
  if (checked !== undefined) props.checked = checked
  if (blockKey !== undefined) props.blockKey = blockKey
  return h('to_do', Object.keys(props).length === 0 ? null : props, children)
}

export const Toggle = ({ children, title, blockKey }: ToggleProps) => {
  const props: Record<string, unknown> = {}
  if (title !== undefined) props.title = title
  if (blockKey !== undefined) props.blockKey = blockKey
  return h('toggle', Object.keys(props).length === 0 ? null : props, children)
}

export const Code = ({ children, language, blockKey }: CodeProps) => {
  const props: Record<string, unknown> = {}
  if (language !== undefined) props.language = language
  if (blockKey !== undefined) props.blockKey = blockKey
  return h('code', Object.keys(props).length === 0 ? null : props, children)
}

export const Quote = ({ children, blockKey }: QuoteProps) =>
  h('quote', keyedProps(blockKey), children)

export const Callout = ({ children, icon, color, blockKey }: CalloutProps) => {
  const props: Record<string, unknown> = {}
  if (icon !== undefined) props.icon = icon
  if (color !== undefined) props.color = color
  if (blockKey !== undefined) props.blockKey = blockKey
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

export const Table = ({
  children,
  tableWidth,
  hasColumnHeader,
  hasRowHeader,
  blockKey,
}: TableProps) => {
  const props: Record<string, unknown> = {}
  if (tableWidth !== undefined) props.tableWidth = tableWidth
  if (hasColumnHeader !== undefined) props.hasColumnHeader = hasColumnHeader
  if (hasRowHeader !== undefined) props.hasRowHeader = hasRowHeader
  if (blockKey !== undefined) props.blockKey = blockKey
  return h('table', Object.keys(props).length === 0 ? null : props, children)
}
export const TableRow = ({ cells }: TableRowProps) => h('table_row', { cells })
export const ColumnList = ({ children, blockKey }: ColumnListProps) =>
  h('column_list', keyedProps(blockKey), children)
export const Column = ({ children, widthRatio, blockKey }: ColumnProps) => {
  const props: Record<string, unknown> = {}
  if (widthRatio !== undefined) props.widthRatio = widthRatio
  if (blockKey !== undefined) props.blockKey = blockKey
  return h('column', Object.keys(props).length === 0 ? null : props, children)
}
export const LinkToPage = ({ pageId }: LinkToPageProps) => h('link_to_page', { pageId })
export const TableOfContents = () => h('table_of_contents', null)
export const ChildPage = ({ title, icon, cover, children }: ChildPageProps) => {
  const p: Record<string, unknown> = {}
  if (title !== undefined) p.title = title
  if (icon !== undefined) p.icon = icon
  if (cover !== undefined) p.cover = cover
  return h('child_page', Object.keys(p).length === 0 ? null : p, children)
}

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
export const Template = ({ content }: PassthroughProps) => Raw({ type: 'template', content })
export const LinkPreview = ({ content }: PassthroughProps) => Raw({ type: 'link_preview', content })
export const SyncedBlock = ({ content }: PassthroughProps) => Raw({ type: 'synced_block', content })
export const ChildDatabase = ({ content }: PassthroughProps) =>
  Raw({ type: 'child_database', content })
export const Breadcrumb = ({ content = {} }: BreadcrumbProps) =>
  Raw({ type: 'breadcrumb', content })
