/**
 * Box component - container with flexbox layout.
 *
 * @example
 * ```tsx
 * <Box flexDirection="row">
 *   <Text>Left</Text>
 *   <Text>Right</Text>
 * </Box>
 * ```
 */

import { createElement, type ReactNode } from 'react'

/** Box component props */
export interface BoxProps {
  /** Flex direction. Default: 'column' */
  flexDirection?: 'row' | 'column' | undefined
  /** Flex grow factor */
  flexGrow?: number | undefined
  /** Flex shrink factor */
  flexShrink?: number | undefined
  /** Flex basis */
  flexBasis?: number | 'auto' | undefined
  /** Align items on cross axis */
  alignItems?: 'flex-start' | 'center' | 'flex-end' | 'stretch' | undefined
  /** Align self */
  alignSelf?: 'auto' | 'flex-start' | 'center' | 'flex-end' | 'stretch' | undefined
  /** Justify content on main axis */
  justifyContent?: 'flex-start' | 'center' | 'flex-end' | 'space-between' | 'space-around' | undefined
  /** Padding (all sides) */
  padding?: number | undefined
  /** Padding top */
  paddingTop?: number | undefined
  /** Padding bottom */
  paddingBottom?: number | undefined
  /** Padding left */
  paddingLeft?: number | undefined
  /** Padding right */
  paddingRight?: number | undefined
  /** Margin (all sides) */
  margin?: number | undefined
  /** Margin top */
  marginTop?: number | undefined
  /** Margin bottom */
  marginBottom?: number | undefined
  /** Margin left */
  marginLeft?: number | undefined
  /** Margin right */
  marginRight?: number | undefined
  /** Gap between children */
  gap?: number | undefined
  /** Fixed width in characters */
  width?: number | string | undefined
  /** Fixed height in lines */
  height?: number | undefined
  /** Minimum width */
  minWidth?: number | undefined
  /** Minimum height */
  minHeight?: number | undefined
  /** Maximum width */
  maxWidth?: number | undefined
  /** Maximum height */
  maxHeight?: number | undefined
  /** Children */
  children?: ReactNode | undefined
}

/**
 * Box component for layout.
 *
 * Uses Yoga (flexbox) for layout calculations.
 */
export const Box = (props: BoxProps): ReactNode => {
  const { children, ...layoutProps } = props
  return createElement('tui-box' as never, layoutProps, children)
}
