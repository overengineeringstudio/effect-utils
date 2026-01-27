/**
 * Synchronous render utility for rendering React elements to a string.
 *
 * This is primarily used for Storybook preview and testing.
 */

import type { ReactNode } from 'react'
import { TuiReconciler, type TuiContainer } from './reconciler/reconciler.ts'
import { calculateLayout } from './reconciler/yoga-utils.ts'
import { renderTreeSimple } from './reconciler/output.ts'

export interface RenderOptions {
  /** Terminal width in columns */
  columns?: number
  /** Terminal height in rows (not currently used but for future) */
  rows?: number
}

export interface RenderResult {
  /** The rendered output as a string with ANSI codes */
  output: string
  /** The rendered output as an array of lines */
  lines: string[]
  /** Cleanup function to unmount the React tree */
  cleanup: () => void
}

/**
 * Synchronously render a React element to a string.
 *
 * @example
 * ```tsx
 * const { output, cleanup } = render(
 *   <Box>
 *     <Text color="green">Hello!</Text>
 *   </Box>,
 *   { columns: 80 }
 * )
 * console.log(output)
 * cleanup()
 * ```
 */
/**
 * Synchronously render a React element to a string.
 * Note: Due to React's async nature, this returns a Promise.
 */
export const renderAsync = (element: ReactNode, options: RenderOptions = {}): Promise<RenderResult> => {
  const { columns = 80 } = options

  return new Promise((resolve) => {
    let lines: string[] = []
    let fiberRoot: ReturnType<typeof TuiReconciler.createContainer>

    // Container that holds the root of the tree
    const container: TuiContainer = {
      root: null,
      onRender: () => {
        // This is called when React commits the tree
        if (container.root) {
          calculateLayout(container.root.yogaNode, columns)
          lines = renderTreeSimple(container.root, columns)
        }
        
        // Use \r\n for proper terminal line breaks (CR returns to column 0, LF moves down)
        const output = lines.join('\r\n')
        resolve({
          output,
          lines,
          cleanup: () => {
            TuiReconciler.updateContainer(null, fiberRoot, null, () => {})
          },
        })
      },
    }

    // Create the fiber root
    fiberRoot = TuiReconciler.createContainer(
      container,
      0, // LegacyRoot
      null, // hydrationCallbacks
      false, // isStrictMode
      null, // concurrentUpdatesByDefaultOverride
      '', // identifierPrefix
      () => {}, // onRecoverableError
      null, // transitionCallbacks
    )

    // Render the element - updateContainer schedules work
    TuiReconciler.updateContainer(element, fiberRoot, null, () => {})
  })
}

/**
 * Synchronous render (for backwards compatibility).
 * WARNING: Due to React's async scheduling, this may return empty results.
 * Use renderAsync for reliable results.
 */
export const render = (element: ReactNode, options: RenderOptions = {}): RenderResult => {
  const { columns = 80 } = options

  let lines: string[] = []

  // Container that holds the root of the tree
  const container: TuiContainer = {
    root: null,
    onRender: () => {
      // This is called when React commits the tree
      if (container.root) {
        calculateLayout(container.root.yogaNode, columns)
        lines = renderTreeSimple(container.root, columns)
      }
    },
  }

  // Create the fiber root
  const fiberRoot = TuiReconciler.createContainer(
    container,
    0, // LegacyRoot
    null, // hydrationCallbacks
    false, // isStrictMode
    null, // concurrentUpdatesByDefaultOverride
    '', // identifierPrefix
    () => {}, // onRecoverableError
    null, // transitionCallbacks
  )

  // Render the element - updateContainer schedules work
  TuiReconciler.updateContainer(element, fiberRoot, null, () => {})

  // Use \r\n for proper terminal line breaks (CR returns to column 0, LF moves down)
  const output = lines.join('\r\n')

  return {
    output,
    lines,
    cleanup: () => {
      TuiReconciler.updateContainer(null, fiberRoot, null, () => {})
    },
  }
}
