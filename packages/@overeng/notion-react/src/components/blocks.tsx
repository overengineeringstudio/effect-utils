import type { ReactNode } from 'react'

import { h } from './h.ts'

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
 */

export const Page = ({ children }: { readonly children?: ReactNode }) => <>{children}</>

export const Paragraph = ({ children }: { readonly children?: ReactNode }) =>
  h('paragraph', null, children)

type HeadingProps = { readonly children?: ReactNode; readonly toggleable?: boolean }
const heading = (tag: 'heading_1' | 'heading_2' | 'heading_3' | 'heading_4') =>
  ({ children, toggleable }: HeadingProps) =>
    h(tag, toggleable === undefined ? null : { toggleable }, children)
export const Heading1 = heading('heading_1')
export const Heading2 = heading('heading_2')
export const Heading3 = heading('heading_3')
export const Heading4 = heading('heading_4')

export const BulletedListItem = ({ children }: { readonly children?: ReactNode }) =>
  h('bulleted_list_item', null, children)
export const NumberedListItem = ({ children }: { readonly children?: ReactNode }) =>
  h('numbered_list_item', null, children)

export const ToDo = ({ children, checked }: { readonly children?: ReactNode; readonly checked?: boolean }) =>
  h('to_do', checked === undefined ? null : { checked }, children)

export const Toggle = ({ children, title }: { readonly children?: ReactNode; readonly title?: string }) =>
  h('toggle', title === undefined ? null : { title }, children)

export const Code = ({ children, language }: { readonly children?: ReactNode; readonly language?: string }) =>
  h('code', language === undefined ? null : { language }, children)

export const Quote = ({ children }: { readonly children?: ReactNode }) => h('quote', null, children)

export const Callout = ({
  children,
  icon,
  color,
}: {
  readonly children?: ReactNode
  readonly icon?: string
  readonly color?: string
}) => {
  const props: Record<string, unknown> = {}
  if (icon !== undefined) props.icon = icon
  if (color !== undefined) props.color = color
  return h('callout', props, children)
}

export const Divider = () => h('divider', null)

type MediaProps = { readonly url?: string; readonly src?: string; readonly caption?: ReactNode }
const mediaUrl = (p: MediaProps): string | undefined => p.url ?? p.src
const media = (tag: string) => (props: MediaProps) => {
  const url = mediaUrl(props)
  return h(tag, url === undefined ? null : { url })
}
export const Image = media('image')
export const Video = media('video')
export const Audio = media('audio')
export const File = media('file')
export const Pdf = media('pdf')

export const Bookmark = ({ url }: { readonly url: string }) => h('bookmark', { url })
export const Embed = ({ url }: { readonly url: string }) => h('embed', { url })

export const Equation = ({ expression }: { readonly expression: string }) =>
  h('equation', { expression })

export const Table = ({ children }: { readonly children?: ReactNode }) => h('table', null, children)
export const TableRow = ({ children }: { readonly children?: ReactNode }) =>
  h('table_row', null, children)
export const ColumnList = ({ children }: { readonly children?: ReactNode }) =>
  h('column_list', null, children)
export const Column = ({ children }: { readonly children?: ReactNode }) =>
  h('column', null, children)
export const LinkToPage = ({ pageId }: { readonly pageId: string }) =>
  h('link_to_page', { pageId })
export const TableOfContents = () => h('table_of_contents', null)
export const ChildPage = ({ title }: { readonly title?: string }) =>
  h('child_page', title === undefined ? null : { title })

/**
 * Schema-typed passthrough for block types that do not yet have ergonomic
 * wrappers. The `content` prop is forwarded verbatim to the renderer and
 * emitted as an opaque payload for the chosen block `type`.
 *
 * TODO: remove once first-class components exist for the relevant types.
 */
export const Raw = <TType extends string>({
  type,
  content,
}: {
  readonly type: TType
  readonly content: unknown
}) => h(type, { content })

// Stubbed 1:1 components that currently pipe through `Raw`.
// TODO: replace each with a schema-driven ergonomic wrapper.
export const Template = ({ content }: { readonly content: unknown }) => (
  <Raw type="template" content={content} />
)
export const LinkPreview = ({ content }: { readonly content: unknown }) => (
  <Raw type="link_preview" content={content} />
)
export const SyncedBlock = ({ content }: { readonly content: unknown }) => (
  <Raw type="synced_block" content={content} />
)
export const ChildDatabase = ({ content }: { readonly content: unknown }) => (
  <Raw type="child_database" content={content} />
)
export const Breadcrumb = ({ content = {} }: { readonly content?: unknown }) => (
  <Raw type="breadcrumb" content={content} />
)
