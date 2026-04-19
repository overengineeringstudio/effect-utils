import type { ReactNode } from 'react'

import type {
  ColorProps,
  InlineAnnotationProps,
  InlineEquationProps,
  LinkProps,
  MentionProps,
  TextProps,
} from '../components/props.ts'

/**
 * DOM-rendered mirrors of the inline components in `../components/inline.tsx`.
 *
 * Prop shapes are shared via `../components/props.ts` so the Notion-host and
 * web variants cannot drift silently.
 */

export const Text = ({ children }: TextProps) => <>{children}</>

export const Bold = ({ children }: InlineAnnotationProps) => <strong>{children}</strong>
export const Italic = ({ children }: InlineAnnotationProps) => <em>{children}</em>
export const Strikethrough = ({ children }: InlineAnnotationProps) => <s>{children}</s>
export const Underline = ({ children }: InlineAnnotationProps) => <u>{children}</u>
export const InlineCode = ({ children }: InlineAnnotationProps) => (
  <code className="notion-inline-code">{children}</code>
)

const colorClass = (value: string): string =>
  value.endsWith('_background')
    ? `notion-bg-${value.replace('_background', '')}`
    : `notion-color-${value}`

export const Color = ({ value, children }: ColorProps) => (
  <span className={colorClass(value)}>{children}</span>
)

export const Link = ({ href, children }: LinkProps) => (
  <a className="notion-link" href={href} target="_blank" rel="noreferrer noopener">
    {children}
  </a>
)

const mentionLabel = (props: MentionProps): ReactNode => {
  if (props.plainText !== undefined) return props.plainText
  const m = props.mention
  if (typeof m['page'] === 'object' && m['page'] !== null) return '@page'
  if (typeof m['user'] === 'object' && m['user'] !== null) return '@user'
  if (typeof m['database'] === 'object' && m['database'] !== null) return '@database'
  if (typeof m['date'] === 'object' && m['date'] !== null) return '@date'
  return '@mention'
}

export const Mention = (props: MentionProps) => (
  <span className="notion-mention">{mentionLabel(props)}</span>
)

export const InlineEquation = ({ expression }: InlineEquationProps) => (
  <code className="notion-equation">{expression}</code>
)
