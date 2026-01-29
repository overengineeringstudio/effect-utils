/**
 * Universal Adapter Context
 *
 * Provides the component adapter to the React tree, allowing universal
 * components to render with the appropriate renderer.
 *
 * @module
 */

import React, { createContext, useContext, type ReactNode } from 'react'

import { createInlineAdapter } from './adapters/inline.tsx'
import type { ComponentAdapter, RendererCapabilities } from './types.ts'
import { InlineCapabilities } from './types.ts'

// =============================================================================
// Context
// =============================================================================

/**
 * Context for the component adapter.
 * @internal
 */
const AdapterContext = createContext<ComponentAdapter | null>(null)

// =============================================================================
// Provider
// =============================================================================

/**
 * Props for AdapterProvider.
 */
export interface AdapterProviderProps {
  /** The component adapter to use */
  readonly adapter: ComponentAdapter
  /** Children to render */
  readonly children: ReactNode
}

/**
 * Provides a component adapter to child components.
 *
 * @example
 * ```tsx
 * import { AdapterProvider, createInlineAdapter } from '@overeng/tui-react/universal'
 *
 * const App = () => (
 *   <AdapterProvider adapter={createInlineAdapter()}>
 *     <MyApp />
 *   </AdapterProvider>
 * )
 * ```
 */
export const AdapterProvider = ({ adapter, children }: AdapterProviderProps): ReactNode => (
  <AdapterContext.Provider value={adapter}>{children}</AdapterContext.Provider>
)

/**
 * Auto-selects adapter based on output mode.
 * Uses inline adapter for progressive-visual modes,
 * and will use alternate adapter for progressive-visual-alternate when available.
 */
export interface AutoAdapterProviderProps {
  /** Children to render */
  readonly children: ReactNode
  /** Force a specific adapter (optional) */
  readonly adapter?: ComponentAdapter | undefined
}

/**
 * Automatically selects the appropriate adapter.
 * Currently defaults to inline adapter.
 *
 * @example
 * ```tsx
 * import { AutoAdapterProvider, Box, Text } from '@overeng/tui-react/universal'
 *
 * const App = () => (
 *   <AutoAdapterProvider>
 *     <Box>
 *       <Text>Works with any renderer!</Text>
 *     </Box>
 *   </AutoAdapterProvider>
 * )
 * ```
 */
export const AutoAdapterProvider = ({ children, adapter }: AutoAdapterProviderProps): ReactNode => {
  // Use provided adapter or default to inline
  const resolvedAdapter = adapter ?? createInlineAdapter()

  return <AdapterContext.Provider value={resolvedAdapter}>{children}</AdapterContext.Provider>
}

// =============================================================================
// Hooks
// =============================================================================

/**
 * Get the current component adapter.
 * Must be used within an AdapterProvider.
 *
 * @throws Error if used outside AdapterProvider
 *
 * @example
 * ```tsx
 * const MyComponent = () => {
 *   const adapter = useAdapter()
 *   const { Box, Text } = adapter
 *   return <Box><Text>Hello!</Text></Box>
 * }
 * ```
 */
export const useAdapter = (): ComponentAdapter => {
  const adapter = useContext(AdapterContext)
  if (!adapter) {
    throw new Error('useAdapter must be used within an AdapterProvider or AutoAdapterProvider')
  }
  return adapter
}

/**
 * Check if a capability is available in the current renderer.
 *
 * @example
 * ```tsx
 * const MyComponent = () => {
 *   const hasScroll = useCapability('scroll')
 *
 *   if (hasScroll) {
 *     return <ScrollBox>...</ScrollBox>
 *   }
 *   return <Box>...</Box>
 * }
 * ```
 */
export const useCapability = (capability: keyof RendererCapabilities): boolean => {
  const adapter = useContext(AdapterContext)
  if (!adapter) {
    // Default to inline capabilities if no adapter
    return InlineCapabilities[capability]
  }
  return adapter.capabilities[capability]
}

/**
 * Get all capabilities of the current renderer.
 */
export const useCapabilities = (): RendererCapabilities => {
  const adapter = useContext(AdapterContext)
  if (!adapter) {
    return InlineCapabilities
  }
  return adapter.capabilities
}
