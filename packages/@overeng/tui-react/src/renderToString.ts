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
 * const output = renderToString(<MyComponent />)
 * console.log(output)
 * ```
 */

import type { ReactElement } from 'react'

import { renderTreeSimple, extractStaticContent } from './reconciler/output.ts'
import type { TuiContainer } from './reconciler/reconciler.ts'
import { TuiReconciler } from './reconciler/reconciler.ts'
import { isStaticElement, type TuiStaticElement } from './reconciler/types.ts'
import { calculateLayout } from './reconciler/yoga-utils.ts'

// =============================================================================
// Options
// =============================================================================

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
 * Note: This function is async because React's reconciler uses microtask scheduling.
 *
 * @param element - React element to render
 * @param options - Render options
 * @returns Promise that resolves to the rendered output as a string
 *
 * @example
 * ```tsx
 * const output = await renderToString(
 *   <Box>
 *     <Text color="green">Hello</Text>
 *   </Box>
 * )
 * console.log(output) // "\x1b[32mHello\x1b[39m"
 * ```
 */
// oxlint-disable-next-line overeng/named-args -- widely used API, breaking change
export const renderToString = async (
  element: ReactElement,
  options: RenderToStringOptions = {},
): Promise<string> => {
  const width = options.width ?? 80
  const lines: string[] = []

  // Container that holds the root of the tree
  const container: TuiContainer = {
    root: null,
    onRender: () => {
      // Capture output when React commits
      if (!container.root) return

      // Clear previous lines (in case of re-render)
      lines.length = 0

      // Handle static content first
      const staticResult = extractStaticContent(container.root, width)
      if (staticResult.lines.length > 0) {
        lines.push(...staticResult.lines)
        // Update the committed count
        if (staticResult.element && isStaticElement(staticResult.element)) {
          ;(staticResult.element as TuiStaticElement).committedCount = staticResult.newItemCount
        }
      }

      // Calculate layout
      calculateLayout(container.root.yogaNode, width)

      // Render to lines
      const dynamicLines = renderTreeSimple(container.root, width)
      lines.push(...dynamicLines)
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

  // Render - this schedules work
  TuiReconciler.updateContainer(element, fiberRoot, null, () => {})

  // Wait for React to process scheduled work
  // React schedules work via microtasks, so we need to yield to the event loop
  // Use multiple yields to ensure all microtasks are processed
  // Note: Using setTimeout(0) for browser compatibility (setImmediate is Node-only)
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await new Promise<void>((resolve) => setTimeout(resolve, 0))

  // Cleanup
  TuiReconciler.updateContainer(null, fiberRoot, null, () => {})

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
// oxlint-disable-next-line overeng/named-args -- widely used API, breaking change
export const renderToLines = async (
  element: ReactElement,
  options: RenderToStringOptions = {},
): Promise<string[]> => {
  const output = await renderToString(element, options)
  return output.split('\n')
}
