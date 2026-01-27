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

import type { ReactNode } from 'react'

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
export const Static = <T,>(_props: StaticProps<T>): ReactNode => {
  // Placeholder: actual implementation will track rendered items
  // and commit new ones to the static region
  return null
}
