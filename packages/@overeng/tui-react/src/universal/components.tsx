/**
 * Universal Components
 *
 * Renderer-agnostic components that work with any adapter.
 * These components automatically use the appropriate renderer-specific
 * implementation based on the current adapter context.
 *
 * @example
 * ```tsx
 * import { AutoAdapterProvider, Box, Text, Spinner } from '@overeng/tui-react/universal'
 *
 * const App = () => (
 *   <AutoAdapterProvider>
 *     <Box flexDirection="row">
 *       <Spinner label="Loading..." />
 *     </Box>
 *     <Text color="green">Ready!</Text>
 *   </AutoAdapterProvider>
 * )
 * ```
 *
 * @module
 */

import React, { type ReactNode } from 'react'

import { useAdapter, useCapability } from './context.tsx'
import type {
  UniversalBoxProps,
  UniversalTextProps,
  UniversalSpinnerProps,
  UniversalStaticProps,
  UniversalScrollBoxProps,
  UniversalInputProps,
  IfCapabilityProps,
} from './types.ts'

// =============================================================================
// Universal Components
// =============================================================================

/**
 * Universal Box component.
 * Container with flexbox layout, works across renderers.
 *
 * @example
 * ```tsx
 * <Box flexDirection="row" gap={2}>
 *   <Text>Left</Text>
 *   <Text>Right</Text>
 * </Box>
 * ```
 */
export const Box = (props: UniversalBoxProps): ReactNode => {
  const adapter = useAdapter()
  return <adapter.Box {...props} />
}

/**
 * Universal Text component.
 * Styled text output, works across renderers.
 *
 * @example
 * ```tsx
 * <Text color="green" bold>Success!</Text>
 * <Text dim>[INFO] Log message</Text>
 * ```
 */
export const Text = (props: UniversalTextProps): ReactNode => {
  const adapter = useAdapter()
  return <adapter.Text {...props} />
}

/**
 * Universal Spinner component.
 * Animated loading indicator, works across renderers.
 *
 * @example
 * ```tsx
 * <Spinner type="dots" color="cyan" label="Loading..." />
 * ```
 */
export const Spinner = (props: UniversalSpinnerProps): ReactNode => {
  const adapter = useAdapter()
  return <adapter.Spinner {...props} />
}

/**
 * Universal Static component.
 * Permanent output region for logs.
 *
 * Note: In alternate screen mode (OpenTUI), this falls back to a regular Box
 * since the entire screen is redrawn on each update.
 *
 * @example
 * ```tsx
 * <Static items={logs}>
 *   {(log, i) => <Text key={i}>{log.message}</Text>}
 * </Static>
 * ```
 */
export const Static = <T,>(props: UniversalStaticProps<T>): ReactNode => {
  const adapter = useAdapter()
  return adapter.Static(props)
}

/**
 * Universal ScrollBox component.
 * Scrollable container for content that exceeds available space.
 *
 * Note: In inline mode (tui-react), this falls back to a regular Box
 * since inline rendering doesn't support scrolling.
 *
 * @example
 * ```tsx
 * <ScrollBox height={10} scrollY>
 *   {items.map(item => <Text key={item.id}>{item.name}</Text>)}
 * </ScrollBox>
 * ```
 */
export const ScrollBox = (props: UniversalScrollBoxProps): ReactNode => {
  const adapter = useAdapter()
  return <adapter.ScrollBox {...props} />
}

/**
 * Universal Input component.
 * Text input field for user interaction.
 *
 * Note: Only available in alternate screen mode (OpenTUI).
 * In inline mode, displays a placeholder message.
 *
 * @example
 * ```tsx
 * <Input
 *   value={searchTerm}
 *   onChange={setSearchTerm}
 *   placeholder="Search..."
 * />
 * ```
 */
export const Input = (props: UniversalInputProps): ReactNode => {
  const adapter = useAdapter()
  if (!adapter.Input) {
    return <adapter.Text dim>[Input not available]</adapter.Text>
  }
  return <adapter.Input {...props} />
}

// =============================================================================
// Conditional Rendering
// =============================================================================

/**
 * Conditionally render content based on renderer capability.
 *
 * @example
 * ```tsx
 * <IfCapability capability="scroll" fallback={<Box>Fallback</Box>}>
 *   <ScrollBox height={10}>Scrollable content</ScrollBox>
 * </IfCapability>
 * ```
 */
export const IfCapability = ({
  capability,
  children,
  fallback = null,
}: IfCapabilityProps): ReactNode => {
  const hasCapability = useCapability(capability)
  return hasCapability ? <>{children}</> : <>{fallback}</>
}

/**
 * Render content only if the renderer supports static regions.
 */
export const IfStatic = ({
  children,
  fallback = null,
}: Omit<IfCapabilityProps, 'capability'>): ReactNode => {
  return (
    <IfCapability capability="static" fallback={fallback}>
      {children}
    </IfCapability>
  )
}

/**
 * Render content only if the renderer supports scrolling.
 */
export const IfScroll = ({
  children,
  fallback = null,
}: Omit<IfCapabilityProps, 'capability'>): ReactNode => {
  return (
    <IfCapability capability="scroll" fallback={fallback}>
      {children}
    </IfCapability>
  )
}

/**
 * Render content only if the renderer supports input.
 */
export const IfInput = ({
  children,
  fallback = null,
}: Omit<IfCapabilityProps, 'capability'>): ReactNode => {
  return (
    <IfCapability capability="input" fallback={fallback}>
      {children}
    </IfCapability>
  )
}

/**
 * Render content only if the renderer supports full screen mode.
 */
export const IfFullScreen = ({
  children,
  fallback = null,
}: Omit<IfCapabilityProps, 'capability'>): ReactNode => {
  return (
    <IfCapability capability="fullScreen" fallback={fallback}>
      {children}
    </IfCapability>
  )
}

// =============================================================================
// Utility Components
// =============================================================================

/**
 * Horizontal rule / divider.
 * Renders a line across the available width.
 *
 * @example
 * ```tsx
 * <Divider />
 * <Divider char="=" color="cyan" />
 * ```
 */
export interface DividerProps {
  readonly char?: string | undefined
  readonly color?: UniversalTextProps['color'] | undefined
  readonly width?: number | undefined
}

export const Divider = ({ char = '-', color, width }: DividerProps): ReactNode => {
  const adapter = useAdapter()
  const line = char.repeat(width ?? 40)
  return (
    <adapter.Text color={color} dim>
      {line}
    </adapter.Text>
  )
}

/**
 * Spacer component for adding vertical space.
 *
 * @example
 * ```tsx
 * <Text>Above</Text>
 * <Spacer lines={2} />
 * <Text>Below</Text>
 * ```
 */
export interface SpacerProps {
  readonly lines?: number | undefined
}

export const Spacer = ({ lines = 1 }: SpacerProps): ReactNode => {
  const adapter = useAdapter()
  return <adapter.Box height={lines}>{null}</adapter.Box>
}

/**
 * Badge component for status indicators.
 *
 * @example
 * ```tsx
 * <Badge color="green">PASS</Badge>
 * <Badge color="red">FAIL</Badge>
 * ```
 */
export interface BadgeProps {
  readonly color?: UniversalTextProps['color'] | undefined
  readonly backgroundColor?: UniversalTextProps['backgroundColor'] | undefined
  readonly children: ReactNode
}

export const Badge = ({ color, backgroundColor, children }: BadgeProps): ReactNode => {
  const adapter = useAdapter()
  return (
    <adapter.Text color={color} backgroundColor={backgroundColor} bold>
      [{children}]
    </adapter.Text>
  )
}
