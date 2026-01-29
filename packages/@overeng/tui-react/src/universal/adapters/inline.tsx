/**
 * Inline Adapter
 *
 * Maps universal components to tui-react inline components.
 * This is the default adapter for progressive-visual mode.
 *
 * @module
 */

import React, { type ReactNode } from 'react'

import { Box as TuiBox } from '../../components/Box.tsx'
import { Spinner as TuiSpinner } from '../../components/Spinner.tsx'
import { Static as TuiStatic } from '../../components/Static.tsx'
import { Text as TuiText } from '../../components/Text.tsx'
import type {
  ComponentAdapter,
  UniversalBoxProps,
  UniversalTextProps,
  UniversalSpinnerProps,
  UniversalStaticProps,
  UniversalScrollBoxProps,
  UniversalInputProps,
} from '../types.ts'
import { InlineCapabilities } from '../types.ts'

// =============================================================================
// Component Mappings
// =============================================================================

/**
 * Box component - maps directly to tui-react Box.
 */
const InlineBox = (props: UniversalBoxProps): ReactNode => {
  return <TuiBox {...props} />
}

/**
 * Text component - maps directly to tui-react Text.
 */
const InlineText = (props: UniversalTextProps): ReactNode => {
  return <TuiText {...props} />
}

/**
 * Spinner component - maps to tui-react Spinner.
 */
const InlineSpinner = (props: UniversalSpinnerProps): ReactNode => {
  const { label, ...spinnerProps } = props

  if (label) {
    return (
      <TuiBox flexDirection="row">
        <TuiSpinner {...spinnerProps} />
        <TuiText> {label}</TuiText>
      </TuiBox>
    )
  }

  return <TuiSpinner {...spinnerProps} />
}

/**
 * Static component - maps directly to tui-react Static.
 */
const InlineStatic = <T,>(props: UniversalStaticProps<T>): ReactNode => {
  return <TuiStatic items={props.items}>{props.children}</TuiStatic>
}

/**
 * ScrollBox component - falls back to Box (inline doesn't support scrolling).
 */
const InlineScrollBox = (props: UniversalScrollBoxProps): ReactNode => {
  const { scrollX: _scrollX, scrollY: _scrollY, ...boxProps } = props
  // Note: Inline mode doesn't support scrolling, just render as a box
  return <TuiBox {...boxProps} />
}

/**
 * Input component - not available in inline mode.
 */
const InlineInput = (_props: UniversalInputProps): ReactNode => {
  // Input is not supported in inline mode
  return <TuiText dim>[Input not available in inline mode]</TuiText>
}

// =============================================================================
// Adapter Factory
// =============================================================================

/**
 * Create an inline adapter that uses tui-react components.
 *
 * @example
 * ```tsx
 * import { AdapterProvider, createInlineAdapter } from '@overeng/tui-react/universal'
 *
 * const adapter = createInlineAdapter()
 *
 * const App = () => (
 *   <AdapterProvider adapter={adapter}>
 *     <MyApp />
 *   </AdapterProvider>
 * )
 * ```
 */
export const createInlineAdapter = (): ComponentAdapter => ({
  name: 'inline',
  capabilities: InlineCapabilities,
  Box: InlineBox,
  Text: InlineText,
  Spinner: InlineSpinner,
  Static: InlineStatic,
  ScrollBox: InlineScrollBox,
  Input: InlineInput, // Available but limited
})
