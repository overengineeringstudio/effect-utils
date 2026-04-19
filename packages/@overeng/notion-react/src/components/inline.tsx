import type { ReactNode } from 'react'

import { INLINE_TAG, type InlineComponent, type InlineTag } from '../renderer/flatten-rich-text.ts'

const tag = <TProps extends { readonly children?: ReactNode }>(
  render: (props: TProps) => ReactNode,
  tagValue: InlineTag,
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
export const Strikethrough = tag<{ readonly children?: ReactNode }>(({ children }) => <>{children}</>, {
  kind: 'annotation',
  patch: { strikethrough: true },
})
export const Underline = tag<{ readonly children?: ReactNode }>(({ children }) => <>{children}</>, {
  kind: 'annotation',
  patch: { underline: true },
})
export const InlineCode = tag<{ readonly children?: ReactNode }>(({ children }) => <>{children}</>, {
  kind: 'annotation',
  patch: { code: true },
})

/** Apply a Notion color (or *_background color) to the wrapped content. */
export const Color = ({ value, children }: { readonly value: string; readonly children?: ReactNode }) => {
  // `Color` is parameterised, so we build a per-call InlineComponent.
  const Comp = tag<{ readonly children?: ReactNode }>(({ children: c }) => <>{c}</>, {
    kind: 'annotation',
    patch: { color: value },
  })
  return <Comp>{children}</Comp>
}

/** Inline text wrapper. Equivalent to raw text children but explicit. */
export const Text = ({ children }: { readonly children?: ReactNode }) => <>{children}</>

/** Inline hyperlink; nested text inherits the `href`. */
export const Link = ({ href, children }: { readonly href: string; readonly children?: ReactNode }) => {
  const Comp = tag<{ readonly children?: ReactNode }>(({ children: c }) => <>{c}</>, {
    kind: 'link',
    url: href,
  })
  return <Comp>{children}</Comp>
}

/** Inline Notion mention (user/page/database/date/etc.). */
export const Mention = ({
  mention,
  plainText,
}: {
  readonly mention: Record<string, unknown>
  readonly plainText?: string
}) => {
  const Comp = tag<{ readonly children?: ReactNode }>(() => null, {
    kind: 'mention',
    mention,
    ...(plainText === undefined ? {} : { plainText }),
  })
  return <Comp />
}

/** Inline KaTeX-style equation. */
export const InlineEquation = ({ expression }: { readonly expression: string }) => {
  const Comp = tag<{ readonly children?: ReactNode }>(() => null, {
    kind: 'equation',
    expression,
  })
  return <Comp />
}
