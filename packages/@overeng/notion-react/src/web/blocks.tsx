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
 *
 * DOM patterns mirror `react-notion-x@v7.10.0` (`packages/react-notion-x/src/
 * block.tsx`) so the vendored CSS contract holds. See
 * `context/notion-react-visual-parity/{analysis,design-decisions}.md`.
 */

/**
 * Root wrapper mirrors react-notion-x's DOM structure.
 * `.notion` applies font-family + color resets; `.notion-page` holds tokens;
 * `.notion-page-content` is the flex-column that makes inline-display blocks
 * (e.g. `.notion-h`) stack vertically.
 */
export const Page = ({ children }: PageProps) => (
  <div className="notion notion-app">
    <div className="notion-page">
      <div className="notion-page-content">{children}</div>
    </div>
  </div>
)

// rnx renders `text` blocks as <div>, not <p> — keeps margin behavior consistent
// with the rest of the block stack and matches the vendored CSS contract.
export const Paragraph = ({ children }: ParagraphProps) => (
  <div className="notion-text">{children}</div>
)

const headingClass = (level: 1 | 2 | 3 | 4) => `notion-h notion-h${level}`

const HeadingTag = ({
  level,
  children,
}: {
  readonly level: 1 | 2 | 3 | 4
  readonly children?: ReactNode
}): ReactElement => {
  const inner = <span className="notion-h-title">{children}</span>
  switch (level) {
    case 1:
      return <h1 className={headingClass(1)}>{inner}</h1>
    case 2:
      return <h2 className={headingClass(2)}>{inner}</h2>
    case 3:
      return <h3 className={headingClass(3)}>{inner}</h3>
    case 4:
      return <h4 className={headingClass(4)}>{inner}</h4>
  }
}

/**
 * Toggleable headings reuse the rnx `<details class="notion-toggle">` shape so
 * vendored `.notion-toggle` styling applies. The header tag goes inside
 * `<summary>`; nested children render in the body div, which rnx leaves
 * unstyled aside from the indent rule `.notion-toggle > div { margin-left }`.
 */
const heading =
  (level: 1 | 2 | 3 | 4) =>
  ({ children, toggleable }: HeadingProps) => {
    if (toggleable === true) {
      return (
        <details className="notion-toggle">
          <summary>
            <HeadingTag level={level}>{children}</HeadingTag>
          </summary>
          <div />
        </details>
      )
    }
    return <HeadingTag level={level}>{children}</HeadingTag>
  }

export const Heading1 = heading(1)
export const Heading2 = heading(2)
export const Heading3 = heading(3)
export const Heading4 = heading(4)

export const BulletedListItem = ({ children }: BulletedListItemProps) => (
  <ul className="notion-list notion-list-disc">
    <li>{children}</li>
  </ul>
)

export const NumberedListItem = ({ children }: NumberedListItemProps) => (
  <ol className="notion-list notion-list-numbered">
    <li>{children}</li>
  </ol>
)

/**
 * SVG check icon copied from `react-notion-x/src/icons/check.tsx` (MIT,
 * Travis Fischer). Inlined here — single use, avoids per-icon files.
 */
const CheckSvg = () => (
  <svg viewBox="0 0 14 14">
    <path d="M5.5 12L14 3.5 12.5 2l-7 7-4-4.003L0 6.499z" />
  </svg>
)

/**
 * To-do checkbox markup follows rnx (`block.tsx` case 'to_do' +
 * `components/checkbox.tsx`): the strike-through lives on
 * `.notion-to-do-body` so the checkbox stays visible.
 */
export const ToDo = ({ children, checked }: ToDoProps) => {
  const isChecked = checked === true
  return (
    <div className="notion-to-do">
      <div className="notion-to-do-item">
        <span className="notion-property notion-property-checkbox">
          {isChecked ? (
            <div className="notion-property-checkbox-checked">
              <CheckSvg />
            </div>
          ) : (
            <div className="notion-property-checkbox-unchecked" />
          )}
        </span>
        <div className={`notion-to-do-body${isChecked ? ' notion-to-do-checked' : ''}`}>
          {children}
        </div>
      </div>
    </div>
  )
}

export const Toggle = ({ children, title }: ToggleProps) => (
  <details className="notion-toggle">
    <summary>{title ?? ''}</summary>
    <div>{children}</div>
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

/**
 * Callout follows rnx: `<div class="notion-callout">` (not `<aside>`),
 * page-icon-inline class on the icon, `_co` color suffix to hit the
 * vendored callout-background rules (distinct from text-color rules).
 */
export const Callout = ({ children, icon, color }: CalloutProps) => (
  <div className={`notion-callout${color !== undefined ? ` notion-${color}_co` : ''}`}>
    {icon !== undefined ? <div className="notion-page-icon-inline">{icon}</div> : null}
    <div className="notion-callout-text">{children}</div>
  </div>
)

export const Divider = () => <hr className="notion-hr" />

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
  <pre className="notion-equation-block">
    <code>{expression}</code>
  </pre>
)

// Outer scroll-wrap is our addition (rnx wraps tables one level higher in
// the block tree we don't model). Documented divergence in design-decisions.md.
export const Table = ({ children }: TableProps) => (
  <div className="notion-simple-table-wrap">
    <table className="notion-simple-table">
      <tbody>{children}</tbody>
    </table>
  </div>
)

export const TableRow = ({ children }: TableRowProps) => (
  <tr className="notion-simple-table-row">{children}</tr>
)

export const ColumnList = ({ children }: ColumnListProps) => (
  <div className="notion-column-list">{children}</div>
)

export const Column = ({ children }: ColumnProps) => <div className="notion-column">{children}</div>

export const LinkToPage = ({ pageId }: LinkToPageProps) => (
  <a className="notion-page-link" href={`#${pageId}`}>
    ↗ page {pageId}
  </a>
)

export const TableOfContents = () => (
  <nav className="notion-table-of-contents" aria-label="table of contents">
    Table of contents
  </nav>
)

export const ChildPage = ({ title }: ChildPageProps) => (
  <div className="notion-page-link">
    <span className="notion-page-icon-inline">📄</span>
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
