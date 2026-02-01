/**
 * useSymbols Hook
 *
 * React hook for accessing terminal symbols with automatic unicode/ascii resolution
 * based on the current RenderConfig context.
 *
 * @example
 * ```tsx
 * import { useSymbols } from '@overeng/tui-react'
 *
 * const StatusLine = () => {
 *   const symbols = useSymbols()
 *   return <Text>{symbols.status.check} Done</Text>
 * }
 * ```
 *
 * @module
 */

import { useMemo } from 'react'

import { resolveSymbols, type Symbols } from '@overeng/tui-core'

import { useRenderConfig } from '../effect/OutputMode.tsx'

/**
 * Hook to access terminal symbols with automatic unicode/ascii resolution.
 *
 * Uses the `unicode` setting from the current `RenderConfig` context to determine
 * whether to return unicode or ASCII symbol variants.
 *
 * @returns Resolved symbols object
 *
 * @example
 * ```tsx
 * const MyComponent = () => {
 *   const symbols = useSymbols()
 *
 *   return (
 *     <Box>
 *       <Text>{symbols.status.check} Success</Text>
 *       <Text>{symbols.status.cross} Failed</Text>
 *       <Text>{symbols.arrows.right} Next</Text>
 *     </Box>
 *   )
 * }
 * ```
 */
export const useSymbols = (): Symbols => {
  const { unicode } = useRenderConfig()
  return useMemo(() => resolveSymbols(!unicode), [unicode])
}

// Re-export types for convenience
export type { Symbols } from '@overeng/tui-core'
