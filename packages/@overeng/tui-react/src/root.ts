/**
 * Root API for creating and managing a React tree in the terminal.
 *
 * This is analogous to ReactDOM.createRoot() but for terminal output.
 */

import type { ReactElement } from 'react'
import { InlineRenderer, type Terminal, type TerminalLike } from '@overeng/tui-core'
import { TuiReconciler, type TuiContainer } from './reconciler/reconciler.ts'
import type { TuiStaticElement } from './reconciler/types.ts'
import { isStaticElement } from './reconciler/types.ts'
import { calculateLayout } from './reconciler/yoga-utils.ts'
import { renderTreeSimple, extractStaticContent } from './reconciler/output.ts'

/** Root instance for rendering React elements to the terminal */
export interface Root {
  /** Render a React element */
  render: (element: ReactElement) => void
  /** Unmount the React tree and cleanup */
  unmount: () => void
}

/**
 * Create a root for rendering React elements to the terminal.
 *
 * @example
 * ```tsx
 * const root = createRoot(process.stdout)
 * root.render(<App />)
 *
 * // Later, cleanup
 * root.unmount()
 * ```
 */
export const createRoot = (terminalOrStream: Terminal | TerminalLike): Root => {
  const renderer = new InlineRenderer(terminalOrStream)
  const terminal = 'columns' in terminalOrStream
    ? terminalOrStream
    : { columns: 80 }

  // Container that holds the root of the tree
  const container: TuiContainer = {
    root: null,
    onRender: () => {
      renderToTerminal()
    },
  }

  // Create the fiber root
  // Using legacy API for simplicity - works with react-reconciler 0.32
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

  /** Render the tree to the terminal */
  const renderToTerminal = (): void => {
    if (!container.root) {
      renderer.render([])
      return
    }

    const width = terminal.columns ?? 80

    // Handle static content first
    const staticResult = extractStaticContent(container.root, width)
    if (staticResult.lines.length > 0) {
      renderer.appendStatic(staticResult.lines)
      // Update the committed count
      if (staticResult.element && isStaticElement(staticResult.element)) {
        ;(staticResult.element as TuiStaticElement).committedCount = staticResult.newItemCount
      }
    }

    // Calculate layout
    calculateLayout(container.root.yogaNode, width)

    // Render to lines (excluding static content which is already rendered)
    const lines = renderTreeSimple(container.root, width)
    renderer.render(lines)
  }

  return {
    render: (element: ReactElement) => {
      TuiReconciler.updateContainer(element, fiberRoot, null, () => {})
    },
    unmount: () => {
      TuiReconciler.updateContainer(null, fiberRoot, null, () => {})
      renderer.dispose()
    },
  }
}
