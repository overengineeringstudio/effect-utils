/**
 * Render React TUI components to a string.
 *
 * This is useful for non-TTY output where you want to render once
 * and capture the result as a string.
 *
 * @example
 * ```tsx
 * import { renderToString } from '@overeng/tui-react'
 *
 * const output = await renderToString({ element: <MyComponent /> })
 * console.log(output)
 * ```
 */

import type { ReactElement } from 'react'

import { renderTreeSimple, extractStaticContent } from './reconciler/output.ts'
import type { TuiContainer } from './reconciler/reconciler.ts'
import { TuiReconciler, flushPendingMicrotasks } from './reconciler/reconciler.ts'
import { isStaticElement, type TuiStaticElement } from './reconciler/types.ts'
import { calculateLayout } from './reconciler/yoga-utils.ts'
import { truncateLines } from './truncate.ts'

// =============================================================================
// Options
// =============================================================================

/** Options for rendering TUI components to a string. */
export interface RenderToStringOptions {
  /**
   * Terminal width for layout calculation.
   * @default 80
   */
  width?: number
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Render a React TUI element to a string.
 *
 * This performs a synchronous render and returns the output as a string.
 * Useful for:
 * - Non-TTY CLI output
 * - Testing
 * - Capturing output for logging
 *
 * Note: This function is async because React's reconciler uses microtask scheduling
 * for hooks like useSyncExternalStore. We use updateContainerSync for the initial
 * render and flushPendingMicrotasks to process any scheduled microtask work.
 *
 * @param element - React element to render
 * @param options - Render options
 * @returns Promise that resolves to the rendered output as a string
 *
 * @example
 * ```tsx
 * const output = await renderToString({
 *   element: (
 *     <Box>
 *       <Text color="green">Hello</Text>
 *     </Box>
 *   ),
 * })
 * console.log(output) // "\x1b[32mHello\x1b[39m"
 * ```
 */
export const renderToString = async ({
  element,
  options = {},
}: {
  element: ReactElement
  options?: RenderToStringOptions
}): Promise<string> => {
  const width = options.width ?? 80
  const lines: string[] = []

  // Container that holds the root of the tree
  const container: TuiContainer = {
    root: null,
    onRender: () => {
      // Capture output when React commits
      if (container.root === null) return

      // Clear previous lines (in case of re-render)
      lines.length = 0

      // Handle static content first
      const staticResult = extractStaticContent({ root: container.root, width })
      if (staticResult.lines.length > 0) {
        // Update the committed count
        if (staticResult.element !== null && isStaticElement(staticResult.element) === true) {
          ;(staticResult.element as TuiStaticElement).committedCount = staticResult.newItemCount
        }
      }

      // Calculate layout
      calculateLayout({ node: container.root.yogaNode, width })

      // Render to lines
      const dynamicLines = renderTreeSimple({ root: container.root, width })

      // Combine static and dynamic lines, then truncate
      const allLines = [...staticResult.lines, ...dynamicLines]
      lines.push(...truncateLines({ lines: allLines, width }))
    },
  }

  // Cast reconciler to include methods that exist at runtime but are missing from
  // @types/react-reconciler. These are stable React internals used by Ink and other
  // custom renderers for synchronous rendering control.
  const reconciler = TuiReconciler as typeof TuiReconciler & {
    updateContainerSync: typeof TuiReconciler.updateContainer
  }

  // Create the fiber root
  const fiberRoot = reconciler.createContainer(
    container,
    0, // LegacyRoot
    null, // hydrationCallbacks
    false, // isStrictMode
    null, // concurrentUpdatesByDefaultOverride
    '', // identifierPrefix
    () => {}, // onRecoverableError
    null, // transitionCallbacks
  )

  // Render synchronously using updateContainerSync (same as root.tsx)
  // This ensures the initial render commits immediately.
  reconciler.updateContainerSync(element, fiberRoot, null, () => {})

  // Flush any pending microtasks (e.g., useSyncExternalStore subscriptions)
  // that React scheduled during the commit phase.
  flushPendingMicrotasks()

  // Yield to the event loop once to allow any remaining async work to settle
  // (e.g., useEffect callbacks that may trigger re-renders).
  await new Promise<void>((resolve) => setTimeout(resolve, 0))

  // Flush again after yielding in case effects scheduled more work
  flushPendingMicrotasks()

  // Cleanup
  reconciler.updateContainerSync(null, fiberRoot, null, () => {})

  return lines.join('\n')
}

/**
 * Render a React TUI element to an array of lines.
 *
 * Similar to renderToString but returns individual lines without joining.
 * Useful when you need to process lines individually.
 *
 * @param element - React element to render
 * @param options - Render options
 * @returns Promise that resolves to an array of output lines
 */
export const renderToLines = async ({
  element,
  options = {},
}: {
  element: ReactElement
  options?: RenderToStringOptions
}): Promise<string[]> => {
  const output = await renderToString({ element, options })
  return output.split('\n')
}
