/**
 * OpenTUI Component Bridge
 *
 * Maps tui-react component API to OpenTUI equivalents for alternate screen mode.
 * These components use OpenTUI's JSX runtime and are designed for full-screen apps.
 *
 * **Usage:**
 * ```tsx
 * // Use OpenTUI JSX pragma
 * /** @jsxImportSource @opentui/react *\/
 *
 * import { OBox, OText, OSpinner } from '@overeng/tui-react/opentui'
 *
 * function Dashboard() {
 *   return (
 *     <OBox flexDirection="column" padding={1}>
 *       <OText color="green" bold>Status: Running</OText>
 *       <OSpinner /> Loading...
 *     </OBox>
 *   )
 * }
 * ```
 *
 * @module
 */

import { createElement, type ReactNode, useState, useEffect } from 'react'

// =============================================================================
// Types
// =============================================================================

/** Color type compatible with both tui-react and OpenTUI */
export type Color =
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'gray'
  | 'grey'
  | `#${string}` // Hex color

/** Flex direction */
export type FlexDirection = 'row' | 'column' | 'row-reverse' | 'column-reverse'

/** Flex alignment */
export type FlexAlign = 'flex-start' | 'flex-end' | 'center' | 'stretch'

/** Flex justify */
export type FlexJustify =
  | 'flex-start'
  | 'flex-end'
  | 'center'
  | 'space-between'
  | 'space-around'
  | 'space-evenly'

// =============================================================================
// OText - Text component for OpenTUI
// =============================================================================

/** Props for the OText component that maps tui-react text styling to OpenTUI. */
export interface OTextProps {
  /** Text color (maps to OpenTUI's `fg`) */
  color?: Color
  /** Background color (maps to OpenTUI's `bg`) */
  backgroundColor?: Color
  /** Bold text */
  bold?: boolean
  /** Dim/faint text */
  dim?: boolean
  /** Italic text */
  italic?: boolean
  /** Underlined text */
  underline?: boolean
  /** Strikethrough text */
  strikethrough?: boolean
  /** Children */
  children?: ReactNode
}

/**
 * Text component for OpenTUI alternate screen mode.
 *
 * Maps tui-react's Text API to OpenTUI's `<text>` element.
 */
export const OText = (props: OTextProps) => {
  const { color, backgroundColor, bold, dim, italic, underline, strikethrough, children } = props

  // Map to OpenTUI props
  const openTuiProps: Record<string, unknown> = {}

  if (color !== undefined) openTuiProps.fg = color
  if (backgroundColor !== undefined) openTuiProps.bg = backgroundColor
  if (bold === true) openTuiProps.bold = true
  if (dim === true) openTuiProps.dim = true
  if (italic === true) openTuiProps.italic = true
  if (underline === true) openTuiProps.underline = true
  if (strikethrough === true) openTuiProps.strikethrough = true

  // Use createElement to create OpenTUI's lowercase elements
  return createElement('text', openTuiProps, children)
}

// =============================================================================
// OBox - Box/container component for OpenTUI
// =============================================================================

/** Props for the OBox container component that maps tui-react layout to OpenTUI. */
export interface OBoxProps {
  /** Flex direction */
  flexDirection?: FlexDirection
  /** Align items */
  alignItems?: FlexAlign
  /** Justify content */
  justifyContent?: FlexJustify
  /** Gap between children */
  gap?: number
  /** Padding (all sides) */
  padding?: number
  /** Padding X (left and right) */
  paddingX?: number
  /** Padding Y (top and bottom) */
  paddingY?: number
  /** Padding left */
  paddingLeft?: number
  /** Padding right */
  paddingRight?: number
  /** Padding top */
  paddingTop?: number
  /** Padding bottom */
  paddingBottom?: number
  /** Width */
  width?: number | string
  /** Height */
  height?: number | string
  /** Min width */
  minWidth?: number
  /** Min height */
  minHeight?: number
  /** Flex grow */
  flexGrow?: number
  /** Flex shrink */
  flexShrink?: number
  /** Show border */
  border?: boolean
  /** Border color */
  borderColor?: Color
  /** Box title (shown in border) */
  title?: string
  /** Whether this box is focused */
  focused?: boolean
  /** Children */
  children?: ReactNode
}

/**
 * Box/container component for OpenTUI alternate screen mode.
 *
 * Maps tui-react's Box API to OpenTUI's `<box>` element.
 */
export const OBox = (props: OBoxProps) => {
  const {
    flexDirection,
    alignItems,
    justifyContent,
    gap,
    padding,
    paddingX,
    paddingY,
    paddingLeft,
    paddingRight,
    paddingTop,
    paddingBottom,
    width,
    height,
    minWidth,
    minHeight,
    flexGrow,
    flexShrink,
    border,
    borderColor,
    title,
    focused,
    children,
  } = props

  // Map to OpenTUI props
  const openTuiProps: Record<string, unknown> = {}

  if (flexDirection !== undefined) openTuiProps.flexDirection = flexDirection
  if (alignItems !== undefined) openTuiProps.alignItems = alignItems
  if (justifyContent !== undefined) openTuiProps.justifyContent = justifyContent
  if (gap !== undefined) openTuiProps.gap = gap

  // Padding
  if (padding !== undefined) openTuiProps.padding = padding
  if (paddingX !== undefined) {
    openTuiProps.paddingLeft = paddingX
    openTuiProps.paddingRight = paddingX
  }
  if (paddingY !== undefined) {
    openTuiProps.paddingTop = paddingY
    openTuiProps.paddingBottom = paddingY
  }
  if (paddingLeft !== undefined) openTuiProps.paddingLeft = paddingLeft
  if (paddingRight !== undefined) openTuiProps.paddingRight = paddingRight
  if (paddingTop !== undefined) openTuiProps.paddingTop = paddingTop
  if (paddingBottom !== undefined) openTuiProps.paddingBottom = paddingBottom

  // Size
  if (width !== undefined) openTuiProps.width = width
  if (height !== undefined) openTuiProps.height = height
  if (minWidth !== undefined) openTuiProps.minWidth = minWidth
  if (minHeight !== undefined) openTuiProps.minHeight = minHeight

  // Flex
  if (flexGrow !== undefined) openTuiProps.flexGrow = flexGrow
  if (flexShrink !== undefined) openTuiProps.flexShrink = flexShrink

  // Border
  if (border === true) openTuiProps.border = true
  if (borderColor !== undefined) openTuiProps.borderColor = borderColor
  if (title !== undefined) openTuiProps.title = title

  // Focus
  if (focused === true) openTuiProps.focused = true

  return createElement('box', openTuiProps, children)
}

// =============================================================================
// OSpinner - Animated spinner for OpenTUI
// =============================================================================

/** Spinner animation frames */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SPINNER_INTERVAL = 80

/** Props for the OSpinner animated spinner component. */
export interface OSpinnerProps {
  /** Spinner color */
  color?: Color
}

/**
 * Animated spinner component for OpenTUI.
 *
 * Uses React state + useEffect for animation since OpenTUI doesn't have
 * a built-in spinner component.
 */
export const OSpinner = (props: OSpinnerProps) => {
  const { color } = props
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length)
    }, SPINNER_INTERVAL)

    return () => clearInterval(interval)
  }, [])

  const textProps: Record<string, unknown> = {}
  if (color !== undefined) textProps.fg = color

  return createElement('text', textProps, SPINNER_FRAMES[frame])
}

// =============================================================================
// OScrollBox - Scrollable container for OpenTUI
// =============================================================================

/** Props for the OScrollBox scrollable container component. */
export interface OScrollBoxProps {
  /** Width */
  width?: number | string
  /** Height */
  height?: number | string
  /** Whether this scrollbox is focused (enables keyboard scrolling) */
  focused?: boolean
  /** Children */
  children?: ReactNode
}

/**
 * Scrollable container for OpenTUI.
 */
export const OScrollBox = (props: OScrollBoxProps) => {
  const { width, height, focused, children } = props

  const openTuiProps: Record<string, unknown> = {}
  if (width !== undefined) openTuiProps.width = width
  if (height !== undefined) openTuiProps.height = height
  if (focused === true) openTuiProps.focused = true

  return createElement('scrollbox', openTuiProps, children)
}

// =============================================================================
// OInput - Text input for OpenTUI
// =============================================================================

/** Props for the OInput text input component for OpenTUI. */
export interface OInputProps {
  /** Placeholder text */
  placeholder?: string
  /** Current value */
  value?: string
  /** Whether this input is focused */
  focused?: boolean
  /** Called on each input change */
  onInput?: (value: string) => void
  /** Called when value changes */
  onChange?: (value: string) => void
  /** Called on submit (Enter key) */
  onSubmit?: (value: string) => void
}

/**
 * Text input component for OpenTUI.
 */
export const OInput = (props: OInputProps) => {
  const { placeholder, value, focused, onInput, onChange, onSubmit } = props

  const openTuiProps: Record<string, unknown> = {}
  if (placeholder !== undefined) openTuiProps.placeholder = placeholder
  if (value !== undefined) openTuiProps.value = value
  if (focused === true) openTuiProps.focused = true
  if (onInput !== undefined) openTuiProps.onInput = onInput
  if (onChange !== undefined) openTuiProps.onChange = onChange
  if (onSubmit !== undefined) openTuiProps.onSubmit = onSubmit

  return createElement('input', openTuiProps)
}
