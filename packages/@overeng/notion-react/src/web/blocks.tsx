import type { ReactElement, ReactNode } from 'react'

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
} from '../components/props.ts'

/**
 * DOM-rendered mirrors of `../components/blocks.tsx`.
 *
 * Prop shapes are shared via `../components/props.ts` so any drift between the
 * Notion-host output and the web preview surfaces as a type error.
 *
 * Styling is carried by `./styles.css` under `.notion-page`. Import it once at
 * the app/Storybook root:
 *
 *     import '@overeng/notion-react/web/styles.css'
 */

export const Page = ({ children }: PageProps) => <div className="notion-page">{children}</div>

export const Paragraph = ({ children }: ParagraphProps) => (
  <p className="notion-paragraph">{children}</p>
)

const headingClass = (level: 1 | 2 | 3 | 4) => `notion-heading notion-heading-${level}`

const Heading1Tag = ({ children }: { readonly children?: ReactNode }) => (
  <h1 className={headingClass(1)}>{children}</h1>
)
const Heading2Tag = ({ children }: { readonly children?: ReactNode }) => (
  <h2 className={headingClass(2)}>{children}</h2>
)
const Heading3Tag = ({ children }: { readonly children?: ReactNode }) => (
  <h3 className={headingClass(3)}>{children}</h3>
)
const Heading4Tag = ({ children }: { readonly children?: ReactNode }) => (
  <h4 className={headingClass(4)}>{children}</h4>
)

const withToggle =
  (Tag: (p: { readonly children?: ReactNode }) => ReactElement, level: 1 | 2 | 3 | 4) =>
  ({ children, toggleable }: HeadingProps) => {
    if (toggleable === true) {
      return (
        <details className={`notion-toggle-heading notion-toggle-heading-${level}`}>
          <summary>
            <Tag>{children}</Tag>
          </summary>
        </details>
      )
    }
    return <Tag>{children}</Tag>
  }

export const Heading1 = withToggle(Heading1Tag, 1)
export const Heading2 = withToggle(Heading2Tag, 2)
export const Heading3 = withToggle(Heading3Tag, 3)
export const Heading4 = withToggle(Heading4Tag, 4)

export const BulletedListItem = ({ children }: BulletedListItemProps) => (
  <ul className="notion-bulleted-list">
    <li>{children}</li>
  </ul>
)

export const NumberedListItem = ({ children }: NumberedListItemProps) => (
  <ol className="notion-numbered-list">
    <li>{children}</li>
  </ol>
)

export const ToDo = ({ children, checked }: ToDoProps) => (
  <div className={`notion-todo${checked === true ? ' notion-todo-checked' : ''}`}>
    <input type="checkbox" checked={checked === true} readOnly aria-label="to-do" />
    <span>{children}</span>
  </div>
)

export const Toggle = ({ children, title }: ToggleProps) => (
  <details className="notion-toggle">
    <summary>{title ?? ''}</summary>
    <div className="notion-toggle-body">{children}</div>
  </details>
)

export const Code = ({ children, language }: CodeProps) => (
  <pre className="notion-code" data-language={language ?? 'plain text'}>
    <code>{children}</code>
  </pre>
)

export const Quote = ({ children }: QuoteProps) => (
  <blockquote className="notion-quote">{children}</blockquote>
)

export const Callout = ({ children, icon, color }: CalloutProps) => (
  <aside
    className={`notion-callout${color !== undefined ? ` notion-color-${color}` : ''}`}
    role="note"
  >
    {icon !== undefined ? <span className="notion-callout-icon">{icon}</span> : null}
    <div className="notion-callout-body">{children}</div>
  </aside>
)

export const Divider = () => <hr className="notion-divider" />

const mediaUrl = (p: MediaProps): string | undefined => p.url ?? p.src

export const Image = (props: MediaProps) => {
  const url = mediaUrl(props)
  if (url === undefined) return <div className="notion-media notion-image notion-empty">image</div>
  return (
    <figure className="notion-media notion-image">
      <img src={url} alt="" />
      {props.caption !== undefined ? <figcaption>{props.caption}</figcaption> : null}
    </figure>
  )
}

export const Video = (props: MediaProps) => (
  <figure className="notion-media notion-video">
    <video src={mediaUrl(props)} controls />
  </figure>
)

export const Audio = (props: MediaProps) => (
  <figure className="notion-media notion-audio">
    <audio src={mediaUrl(props)} controls />
  </figure>
)

export const File = (props: MediaProps) => (
  <a className="notion-media notion-file" href={mediaUrl(props) ?? '#'}>
    file
  </a>
)

export const Pdf = (props: MediaProps) => (
  <a className="notion-media notion-pdf" href={mediaUrl(props) ?? '#'}>
    pdf
  </a>
)

export const Bookmark = ({ url }: BookmarkProps) => (
  <a className="notion-bookmark" href={url} target="_blank" rel="noreferrer noopener">
    {url}
  </a>
)

export const Embed = ({ url }: EmbedProps) => (
  <div className="notion-embed">
    <a href={url}>{url}</a>
  </div>
)

export const Equation = ({ expression }: EquationProps) => (
  <pre className="notion-block-equation">
    <code>{expression}</code>
  </pre>
)

export const Table = ({ children }: TableProps) => (
  <div className="notion-table-wrap">
    <table className="notion-table">
      <tbody>{children}</tbody>
    </table>
  </div>
)

export const TableRow = ({ children }: TableRowProps) => (
  <tr className="notion-table-row">{children}</tr>
)

export const ColumnList = ({ children }: ColumnListProps) => (
  <div className="notion-column-list">{children}</div>
)

export const Column = ({ children }: ColumnProps) => (
  <div className="notion-column">{children}</div>
)

export const LinkToPage = ({ pageId }: LinkToPageProps) => (
  <a className="notion-link-to-page" href={`#${pageId}`}>
    ↗ page {pageId}
  </a>
)

export const TableOfContents = () => (
  <nav className="notion-toc" aria-label="table of contents">
    Table of contents
  </nav>
)

export const ChildPage = ({ title }: ChildPageProps) => (
  <div className="notion-child-page">
    <span className="notion-child-page-icon">📄</span>
    <span>{title ?? 'Untitled'}</span>
  </div>
)

export const Raw = <TType extends string>({ type, content }: RawProps<TType>) => (
  <div className="notion-raw" data-type={type}>
    <code>{JSON.stringify(content)}</code>
  </div>
)

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
