import type { ReactNode } from 'react'

import { INLINE_TAG, type InlineComponent, type InlineTag } from '../renderer/flatten-rich-text.ts'

const tag = <TProps extends { readonly children?: ReactNode }>(
  render: (props: TProps) => ReactNode,
  tagValue: InlineTag | ((props: TProps) => InlineTag),
): ((props: TProps) => ReactNode) => {
  const fn = render as InlineComponent & ((props: TProps) => ReactNode)
  Object.defineProperty(fn, INLINE_TAG, { value: tagValue, enumerable: false })
  return fn
}

/** Inline annotation: emits children wrapped in a bold annotation. */
export const Bold = tag<{ readonly children?: ReactNode }>(({ children }) => <>{children}</>, {
  kind: 'annotation',
  patch: { bold: true },
})
export const Italic = tag<{ readonly children?: ReactNode }>(({ children }) => <>{children}</>, {
  kind: 'annotation',
  patch: { italic: true },
})
export const Strikethrough = tag<{ readonly children?: ReactNode }>(
  ({ children }) => <>{children}</>,
  {
    kind: 'annotation',
    patch: { strikethrough: true },
  },
)
export const Underline = tag<{ readonly children?: ReactNode }>(({ children }) => <>{children}</>, {
  kind: 'annotation',
  patch: { underline: true },
})
export const InlineCode = tag<{ readonly children?: ReactNode }>(
  ({ children }) => <>{children}</>,
  {
    kind: 'annotation',
    patch: { code: true },
  },
)

/** Apply a Notion color (or *_background color) to the wrapped content. */
export const Color = tag<{ readonly value: string; readonly children?: ReactNode }>(
  ({ children }) => <>{children}</>,
  (props) => ({ kind: 'annotation', patch: { color: props.value } }),
)

/** Inline text wrapper. Equivalent to raw text children but explicit. */
export const Text = ({ children }: { readonly children?: ReactNode }) => <>{children}</>

/** Inline hyperlink; nested text inherits the `href`. */
export const Link = tag<{ readonly href: string; readonly children?: ReactNode }>(
  ({ children }) => <>{children}</>,
  (props) => ({ kind: 'link', url: props.href }),
)

/** Inline Notion mention (user/page/database/date/etc.). */
export const Mention = tag<{
  readonly mention: Record<string, unknown>
  readonly plainText?: string
  readonly children?: ReactNode
}>(
  () => null,
  (props) => ({
    kind: 'mention',
    mention: props.mention,
    ...(props.plainText === undefined ? {} : { plainText: props.plainText }),
  }),
)

/** Inline KaTeX-style equation. */
export const InlineEquation = tag<{ readonly expression: string; readonly children?: ReactNode }>(
  () => null,
  (props) => ({ kind: 'equation', expression: props.expression }),
)
