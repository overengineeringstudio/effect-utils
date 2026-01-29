/**
 * Universal Component Types
 *
 * Defines canonical component specifications that work across different renderers
 * (inline TUI, OpenTUI alternate screen, etc.)
 *
 * @module
 */

import type { ReactNode, ComponentType } from 'react'

import type { Color } from '@overeng/tui-core'

// =============================================================================
// Canonical Props (renderer-agnostic)
// =============================================================================

/**
 * Universal Box props - container with flexbox layout.
 * Maps to tui-box (inline) or OBox (OpenTUI).
 */
export interface UniversalBoxProps {
  // Flex layout
  readonly flexDirection?: 'row' | 'column' | undefined
  readonly flexGrow?: number | undefined
  readonly flexShrink?: number | undefined
  readonly flexBasis?: number | 'auto' | undefined
  readonly alignItems?: 'flex-start' | 'center' | 'flex-end' | 'stretch' | undefined
  readonly alignSelf?: 'auto' | 'flex-start' | 'center' | 'flex-end' | 'stretch' | undefined
  readonly justifyContent?:
    | 'flex-start'
    | 'center'
    | 'flex-end'
    | 'space-between'
    | 'space-around'
    | undefined
  readonly gap?: number | undefined

  // Spacing
  readonly padding?: number | undefined
  readonly paddingTop?: number | undefined
  readonly paddingBottom?: number | undefined
  readonly paddingLeft?: number | undefined
  readonly paddingRight?: number | undefined
  readonly margin?: number | undefined
  readonly marginTop?: number | undefined
  readonly marginBottom?: number | undefined
  readonly marginLeft?: number | undefined
  readonly marginRight?: number | undefined

  // Sizing
  readonly width?: number | string | undefined
  readonly height?: number | undefined
  readonly minWidth?: number | undefined
  readonly minHeight?: number | undefined
  readonly maxWidth?: number | undefined
  readonly maxHeight?: number | undefined

  // Styling
  readonly backgroundColor?: Color | undefined

  // Children
  readonly children?: ReactNode | undefined
}

/**
 * Universal Text props - styled text output.
 * Maps to tui-text (inline) or OText (OpenTUI).
 */
export interface UniversalTextProps {
  readonly color?: Color | undefined
  readonly backgroundColor?: Color | undefined
  readonly bold?: boolean | undefined
  readonly dim?: boolean | undefined
  readonly italic?: boolean | undefined
  readonly underline?: boolean | undefined
  readonly strikethrough?: boolean | undefined
  readonly wrap?: 'wrap' | 'truncate' | 'truncate-end' | 'truncate-middle' | undefined
  readonly children?: ReactNode | undefined
}

/**
 * Universal Spinner props - animated loading indicator.
 * Maps to Spinner (inline) or OSpinner (OpenTUI).
 */
export interface UniversalSpinnerProps {
  readonly type?: 'dots' | 'line' | 'arc' | 'bounce' | 'bar' | undefined
  readonly color?: Color | undefined
  readonly label?: string | undefined
}

/**
 * Universal Static props - permanent output region for logs.
 * Maps to Static (inline) or falls back to Box (OpenTUI - no native support).
 */
export interface UniversalStaticProps<T> {
  readonly items: readonly T[]
  readonly children: (item: T, index: number) => ReactNode
}

/**
 * Universal ScrollBox props - scrollable container.
 * Maps to ScrollBox (OpenTUI) or falls back to Box (inline - no native scrolling).
 */
export interface UniversalScrollBoxProps {
  readonly width?: number | string | undefined
  readonly height?: number | undefined
  readonly scrollX?: boolean | undefined
  readonly scrollY?: boolean | undefined
  readonly children?: ReactNode | undefined
}

/**
 * Universal Input props - text input field.
 * Maps to Input (OpenTUI) or is unavailable in inline mode.
 */
export interface UniversalInputProps {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly placeholder?: string | undefined
  readonly disabled?: boolean | undefined
  readonly width?: number | undefined
}

// =============================================================================
// Renderer Capabilities
// =============================================================================

/**
 * Capabilities that a renderer may support.
 * Used for conditional rendering based on available features.
 */
export interface RendererCapabilities {
  /** Supports Static component (permanent log region) */
  readonly static: boolean
  /** Supports scrollable containers */
  readonly scroll: boolean
  /** Supports text input */
  readonly input: boolean
  /** Supports mouse events */
  readonly mouse: boolean
  /** Supports keyboard focus management */
  readonly focus: boolean
  /** Supports alternate screen buffer */
  readonly alternateScreen: boolean
  /** Supports full terminal takeover */
  readonly fullScreen: boolean
}

/** Capabilities for inline renderer (tui-react) */
export const InlineCapabilities: RendererCapabilities = {
  static: true,
  scroll: false,
  input: false,
  mouse: false,
  focus: false,
  alternateScreen: false,
  fullScreen: false,
}

/** Capabilities for alternate renderer (OpenTUI) */
export const AlternateCapabilities: RendererCapabilities = {
  static: false, // OpenTUI doesn't have Static concept - full screen redraw
  scroll: true,
  input: true,
  mouse: true,
  focus: true,
  alternateScreen: true,
  fullScreen: true,
}

// =============================================================================
// Adapter Interface
// =============================================================================

/**
 * Component adapter - maps universal props to renderer-specific components.
 */
export interface ComponentAdapter {
  /** Adapter name for debugging */
  readonly name: string

  /** Renderer capabilities */
  readonly capabilities: RendererCapabilities

  /** Box component */
  readonly Box: ComponentType<UniversalBoxProps>

  /** Text component */
  readonly Text: ComponentType<UniversalTextProps>

  /** Spinner component */
  readonly Spinner: ComponentType<UniversalSpinnerProps>

  /** Static component (may be a fallback) */
  readonly Static: <T>(props: UniversalStaticProps<T>) => ReactNode

  /** ScrollBox component (may be a fallback) */
  readonly ScrollBox: ComponentType<UniversalScrollBoxProps>

  /** Input component (may be unavailable) */
  readonly Input: ComponentType<UniversalInputProps> | null
}

// =============================================================================
// Conditional Rendering
// =============================================================================

/**
 * Props for IfCapability component.
 */
export interface IfCapabilityProps {
  /** Capability to check */
  readonly capability: keyof RendererCapabilities
  /** Content to render if capability is available */
  readonly children: ReactNode
  /** Fallback content if capability is unavailable */
  readonly fallback?: ReactNode | undefined
}
