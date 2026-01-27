/**
 * Root API for creating and managing a React tree in the terminal.
 *
 * This is analogous to ReactDOM.createRoot() but for terminal output.
 */

import type { ReactElement } from 'react'
import { InlineRenderer, type Terminal, type TerminalLike } from '@overeng/tui-core'

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

  // TODO: Implement React reconciler integration
  // For now, this is a placeholder that demonstrates the API shape

  return {
    render: (_element: ReactElement) => {
      // Placeholder: will use React reconciler to convert element tree to lines
      renderer.render(['[tui-react] Render not yet implemented'])
    },
    unmount: () => {
      renderer.dispose()
    },
  }
}
