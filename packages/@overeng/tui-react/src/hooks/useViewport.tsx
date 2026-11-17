/**
 * Viewport context and hook for terminal-aware components.
 *
 * Provides components with access to terminal dimensions so they can
 * adapt their rendering to available space.
 */

import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'

// =============================================================================
// Types
// =============================================================================

/** Available rendering space: log output has width but no vertical viewport. */
export type Viewport =
  | { readonly _tag: 'bounded'; readonly columns: number; readonly rows: number }
  | { readonly _tag: 'unbounded'; readonly columns: number }

/** Internal context value with update capability */
interface ViewportContextValue {
  readonly viewport: Viewport
}

// =============================================================================
// Context
// =============================================================================

const defaultViewport: Viewport = {
  _tag: 'bounded',
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
        _tag: 'bounded',
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
  const value = useMemo(() => ({ viewport }), [viewport])
  return <ViewportContext.Provider value={value}>{children}</ViewportContext.Provider>
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
 *   const viewport = useViewport()
 *
 *   // Only interactive frames have a vertical limit.
 *   const maxItems = viewport._tag === 'bounded' ? Math.max(1, viewport.rows - 4) : items.length
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
