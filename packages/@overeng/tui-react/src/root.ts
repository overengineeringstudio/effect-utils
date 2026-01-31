/**
 * Root API for creating and managing a React tree in the terminal.
 *
 * This is analogous to ReactDOM.createRoot() but for terminal output.
 */

import React, { type ReactElement } from 'react'

import { InlineRenderer, type Terminal, type TerminalLike, type ExitMode } from '@overeng/tui-core'

import { ViewportProvider, type Viewport } from './hooks/useViewport.tsx'
import { renderTreeSimple, extractStaticContent } from './reconciler/output.ts'
import { truncateLines } from './truncate.ts'
import { TuiReconciler, type TuiContainer } from './reconciler/reconciler.ts'
import type { TuiStaticElement } from './reconciler/types.ts'
import { isStaticElement } from './reconciler/types.ts'
import { calculateLayout } from './reconciler/yoga-utils.ts'

// =============================================================================
// Types
// =============================================================================

/** Options for createRoot */
export interface CreateRootOptions {
  /**
   * Minimum milliseconds between renders.
   * Helps prevent excessive rendering for high-frequency state updates.
   * @default 16 (~60fps)
   */
  readonly throttleMs?: number

  /**
   * Maximum lines for the dynamic region.
   * Content exceeding this will be truncated with a "... N more lines" indicator.
   * @default 100
   */
  readonly maxDynamicLines?: number

  /**
   * Maximum lines to keep in the static region buffer.
   * Older lines are discarded when exceeded.
   * Set to Infinity to keep all lines (default).
   * @default Infinity
   */
  readonly maxStaticLines?: number
}

/** Options for unmount */
export interface UnmountOptions {
  /**
   * Exit mode controlling what happens to rendered output.
   * - `persist` (default): Keep all output visible (final render stays)
   * - `clear`: Remove all output (both static and dynamic)
   * - `clearDynamic`: Keep static logs, clear dynamic region
   */
  mode?: ExitMode
}

/** Root instance for rendering React elements to the terminal */
export interface Root {
  /** Render a React element */
  render: (element: ReactElement) => void
  /**
   * Unmount the React tree and cleanup.
   * @param options - Options controlling exit behavior
   */
  unmount: (options?: UnmountOptions) => void
  /** Current viewport dimensions */
  readonly viewport: Viewport
}

// =============================================================================
// Implementation
// =============================================================================

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
 *
 * @example With options
 * ```tsx
 * const root = createRoot(process.stdout, {
 *   throttleMs: 32,        // ~30fps max
 *   maxDynamicLines: 50,   // Truncate if > 50 lines
 * })
 * ```
 */
export const createRoot = ({
  terminalOrStream,
  options = {},
}: {
  terminalOrStream: Terminal | TerminalLike
  options?: CreateRootOptions
}): Root => {
  const { throttleMs = 16, maxDynamicLines = 100, maxStaticLines = Infinity } = options

  const renderer = new InlineRenderer({ terminalOrStream })

  // Resolve terminal interface
  const terminal: Terminal =
    'isTTY' in terminalOrStream && typeof terminalOrStream.columns === 'number'
      ? (terminalOrStream as Terminal)
      : {
          write: (data: string) => {
            ;(terminalOrStream as TerminalLike).write(data)
          },
          get columns() {
            return (terminalOrStream as TerminalLike).columns ?? 80
          },
          get rows() {
            return (terminalOrStream as TerminalLike).rows ?? 24
          },
          get isTTY() {
            return (terminalOrStream as TerminalLike).isTTY ?? false
          },
        }

  // Viewport state
  let viewport: Viewport = {
    columns: terminal.columns,
    rows: terminal.rows,
  }

  // Throttling state
  let lastRenderTime = 0
  let pendingRender = false
  let renderScheduled = false

  // Static line tracking (for maxStaticLines)
  let staticLineCount = 0

  // Track if disposed (to prevent rendering after unmount)
  let disposed = false

  // Container that holds the root of the tree
  const container: TuiContainer = {
    root: null,
    onRender: () => {
      if (!disposed) {
        scheduleRender()
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

  /** Schedule a render with throttling */
  const scheduleRender = (): void => {
    if (disposed) return

    if (throttleMs <= 0) {
      // No throttling
      doRender()
      return
    }

    const now = Date.now()
    const elapsed = now - lastRenderTime

    if (elapsed >= throttleMs) {
      // Enough time has passed, render immediately
      doRender()
      lastRenderTime = now
      pendingRender = false
    } else if (!renderScheduled) {
      // Schedule render for later
      renderScheduled = true
      pendingRender = true
      setTimeout(() => {
        renderScheduled = false
        if (pendingRender) {
          doRender()
          lastRenderTime = Date.now()
          pendingRender = false
        }
      }, throttleMs - elapsed)
    } else {
      // Already scheduled, just mark as pending
      pendingRender = true
    }
  }

  /** Perform the actual render */
  const doRender = (): void => {
    if (!container.root) {
      renderer.render([])
      return
    }

    // Update viewport (terminal might have resized)
    viewport = {
      columns: terminal.columns,
      rows: terminal.rows,
    }

    const width = viewport.columns

    // Handle static content first
    const staticResult = extractStaticContent({ root: container.root, width })
    if (staticResult.lines.length > 0) {
      let linesToAppend = staticResult.lines

      // Apply maxStaticLines limit
      if (maxStaticLines !== Infinity) {
        const newTotal = staticLineCount + linesToAppend.length
        if (newTotal > maxStaticLines) {
          // Truncate oldest (we can only control new additions)
          const allowedNew = Math.max(0, maxStaticLines - staticLineCount)
          if (allowedNew < linesToAppend.length) {
            linesToAppend = linesToAppend.slice(-allowedNew)
          }
        }
        staticLineCount = Math.min(staticLineCount + linesToAppend.length, maxStaticLines)
      }

      if (linesToAppend.length > 0) {
        // Truncate lines to prevent soft wrapping
        const truncatedStaticLines = truncateLines(linesToAppend, width)
        renderer.appendStatic(truncatedStaticLines)
      }

      // Update the committed count
      if (staticResult.element && isStaticElement(staticResult.element)) {
        ;(staticResult.element as TuiStaticElement).committedCount = staticResult.newItemCount
      }
    }

    // Calculate layout
    calculateLayout({ node: container.root.yogaNode, width })

    // Render to lines
    let lines = renderTreeSimple({ root: container.root, width })

    // Truncate lines to prevent soft wrapping (which causes ghost lines during updates)
    lines = truncateLines(lines, width)

    // Apply maxDynamicLines limit
    if (lines.length > maxDynamicLines) {
      const truncated = lines.slice(0, maxDynamicLines - 1)
      const hiddenCount = lines.length - maxDynamicLines + 1
      truncated.push(`... ${hiddenCount} more line${hiddenCount > 1 ? 's' : ''}`)
      lines = truncated
    }

    renderer.render(lines)
  }

  /** Wrap element with viewport provider */
  const wrapWithProviders = (element: ReactElement): ReactElement => {
    return React.createElement(
      ViewportProvider,
      {
        viewport,
        onResize: (newViewport: Viewport) => {
          viewport = newViewport
        },
      },
      element,
    )
  }

  return {
    render: (element: ReactElement) => {
      TuiReconciler.updateContainer(wrapWithProviders(element), fiberRoot, null, () => {})
    },
    unmount: (options?: UnmountOptions) => {
      // Mark as disposed to prevent any more renders
      disposed = true
      // Dispose renderer (preserves content for persist mode)
      renderer.dispose({ mode: options?.mode ?? 'persist' })
      // Clean up React internals (won't trigger render due to disposed flag)
      TuiReconciler.updateContainer(null, fiberRoot, null, () => {})
    },
    get viewport() {
      return viewport
    },
  }
}
