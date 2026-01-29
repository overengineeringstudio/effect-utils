/**
 * Viewport context and hook for terminal-aware components.
 *
 * Provides components with access to terminal dimensions so they can
 * adapt their rendering to available space.
 */

import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'

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
  viewport: initialViewport,
  children,
  onResize,
}: ViewportProviderProps): ReactNode => {
  const [viewport, setViewport] = useState<Viewport>(initialViewport)

  // Update if initial viewport changes (e.g., from createRoot)
  useEffect(() => {
    setViewport(initialViewport)
  }, [initialViewport])

  // Listen for resize events if in Node.js environment
  useEffect(() => {
    if (typeof process === 'undefined' || !process.stdout?.on) {
      return
    }

    const handleResize = () => {
      const newViewport: Viewport = {
        columns: process.stdout.columns ?? 80,
        rows: process.stdout.rows ?? 24,
      }
      setViewport(newViewport)
      onResize?.(newViewport)
    }

    process.stdout.on('resize', handleResize)
    return () => {
      process.stdout.off('resize', handleResize)
    }
  }, [onResize])

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
