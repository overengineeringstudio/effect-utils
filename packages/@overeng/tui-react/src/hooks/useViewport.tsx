/**
 * Viewport context and hook for terminal-aware components.
 *
 * Provides components with access to terminal dimensions so they can
 * adapt their rendering to available space.
 */

import { createContext, useContext, useEffect, type ReactNode } from 'react'

// =============================================================================
// Types
// =============================================================================

/** Viewport information for components */
export interface Viewport {
  /** Terminal width in columns */
  readonly columns: number
  /** Terminal height in rows */
  readonly rows: number
}

/** Internal context value with update capability */
interface ViewportContextValue {
  readonly viewport: Viewport
}

// =============================================================================
// Context
// =============================================================================

const defaultViewport: Viewport = {
  columns: 80,
  rows: 24,
}

const ViewportContext = createContext<ViewportContextValue>({
  viewport: defaultViewport,
})

// =============================================================================
// Provider
// =============================================================================

/** Props for the ViewportProvider component that supplies terminal dimensions to children. */
export interface ViewportProviderProps {
  /** Initial viewport dimensions */
  readonly viewport: Viewport
  /** Children to render */
  readonly children?: ReactNode
  /** Optional callback when resize is detected (for external handling) */
  readonly onResize?: (viewport: Viewport) => void
}

/**
 * Provides viewport context to child components.
 *
 * In a real terminal, this should be created by createRoot with
 * actual terminal dimensions.
 */
export const ViewportProvider = ({
  viewport,
  children,
  onResize,
}: ViewportProviderProps): ReactNode => {
  // Listen for resize events if in Node.js environment
  useEffect(() => {
    if (typeof process === 'undefined' || process.stdout?.on === undefined) {
      return
    }

    const handleResize = () => {
      const newViewport: Viewport = {
        columns: process.stdout.columns ?? 80,
        rows: process.stdout.rows ?? 24,
      }
      onResize?.(newViewport)
    }

    process.stdout.on('resize', handleResize)
    return () => {
      process.stdout.off('resize', handleResize)
    }
  }, [onResize])

  // Pass viewport prop directly through context. The createRoot doRender()
  // re-renders the tree with updated viewport, so no local state is needed.
  return <ViewportContext.Provider value={{ viewport }}>{children}</ViewportContext.Provider>
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Access the current terminal viewport dimensions.
 *
 * @example
 * ```tsx
 * const MyComponent = () => {
 *   const { columns, rows } = useViewport()
 *
 *   // Adapt to available space
 *   const maxItems = Math.max(1, rows - 4)  // Leave room for header/footer
 *
 *   return (
 *     <Box>
 *       {items.slice(0, maxItems).map(item => <Item key={item.id} />)}
 *       {items.length > maxItems && (
 *         <Text dimColor>... and {items.length - maxItems} more</Text>
 *       )}
 *     </Box>
 *   )
 * }
 * ```
 */
export const useViewport = (): Viewport => {
  const context = useContext(ViewportContext)
  return context.viewport
}

/**
 * Get the viewport context value (for internal use).
 * @internal
 */
export const useViewportContext = (): ViewportContextValue => {
  return useContext(ViewportContext)
}
