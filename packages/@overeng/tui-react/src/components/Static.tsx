/**
 * Static component - permanent output region for logs.
 *
 * Items rendered by Static are printed once and never re-rendered.
 * New items are appended above the dynamic region.
 *
 * @example
 * ```tsx
 * const [logs, setLogs] = useState<string[]>([])
 *
 * <Static items={logs}>
 *   {(log, i) => <Text key={i} dim>{log}</Text>}
 * </Static>
 * <Box>
 *   <Spinner /> <Text>Processing...</Text>
 * </Box>
 * ```
 */

import { createElement, type ReactNode, Fragment } from 'react'

/** Static component props */
export interface StaticProps<T> {
  /** Items to render (new items will be appended) */
  items: readonly T[]
  /** Render function for each item */
  children: (item: T, index: number) => ReactNode
}

/**
 * Static component for permanent output.
 *
 * Renders items once and commits them to the static region.
 * The static region appears above the dynamic region and persists.
 */
export const Static = <T,>(props: StaticProps<T>): ReactNode => {
  const { items, children: renderItem } = props
  
  // Render all items as children of the static element
  // The reconciler tracks which have been committed
  const renderedItems = items.map((item, index) => {
    const rendered = renderItem(item, index)
    // Wrap in a fragment with key if not already keyed
    return createElement(Fragment, { key: index }, rendered)
  })

  return createElement('tui-static' as never, {}, ...renderedItems)
}
