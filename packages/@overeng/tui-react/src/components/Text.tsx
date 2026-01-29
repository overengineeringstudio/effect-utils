/**
 * Text component - styled text output.
 *
 * @example
 * ```tsx
 * <Text color="green" bold>Success!</Text>
 * <Text dim>[INFO] Log message</Text>
 * ```
 */

import { createElement, type ReactNode } from 'react'

import type { Color } from '@overeng/tui-core'

/** Text component props */
export interface TextProps {
  /** Text color */
  color?: Color | undefined
  /** Background color */
  backgroundColor?: Color | undefined
  /** Bold text */
  bold?: boolean | undefined
  /** Dim text */
  dim?: boolean | undefined
  /** Italic text */
  italic?: boolean | undefined
  /** Underlined text */
  underline?: boolean | undefined
  /** Strikethrough text */
  strikethrough?: boolean | undefined
  /** Text wrap mode */
  wrap?: 'wrap' | 'truncate' | 'truncate-end' | 'truncate-middle' | undefined
  /** Children (text content) */
  children?: ReactNode | undefined
}

/**
 * Text component for styled text output.
 *
 * Applies ANSI styles to text content.
 */
export const Text = (props: TextProps): ReactNode => {
  const { children, ...styleProps } = props
  return createElement('tui-text' as never, styleProps, children)
}
