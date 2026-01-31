/**
 * Root API for creating and managing a React tree in the terminal.
 *
 * This is analogous to ReactDOM.createRoot() but for terminal output.
 */

import React, { type ReactElement } from 'react'

import {
  InlineRenderer,
  resolveTerminal,
  type Terminal,
  type TerminalLike,
  type ExitMode,
} from '@overeng/tui-core'

import { ViewportProvider, type Viewport } from './hooks/useViewport.tsx'
import { renderTreeSimple, extractStaticContent } from './reconciler/output.ts'
import { TuiReconciler, type TuiContainer } from './reconciler/reconciler.ts'
import type { TuiStaticElement } from './reconciler/types.ts'
import { isStaticElement } from './reconciler/types.ts'
import { calculateLayout } from './reconciler/yoga-utils.ts'
import { truncateLines } from './truncate.ts'

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
  /**
   * Flush any pending renders synchronously.
   * Use this before unmount to ensure all state changes are rendered.
   */
  flush: () => void
  /**
   * Notify the root that the terminal has resized.
   * Triggers a re-render which will self-correct if dimensions changed.
   * Call this from ResizeObserver (browser) or process.stdout.on('resize') (Node).
   */
  resize: () => void
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

  // Resolve terminal interface once, share with renderer
  const terminal = resolveTerminal(terminalOrStream)
  const renderer = new InlineRenderer({ terminal })

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

  // Track last rendered width for self-correcting resize detection
  let lastRenderedWidth = terminal.columns

  // Track last rendered element for re-rendering in flush
  let lastRenderedElement: ReactElement | null = null

  // Container that holds the root of the tree
  const container: TuiContainer = {
    root: null,
    onRender: () => {
      if (!disposed) {
        scheduleRender()
      }
    },
  }

  // Cast reconciler to include methods that exist at runtime but are missing from
  // @types/react-reconciler. These are stable React internals used by Ink and other
  // custom renderers for synchronous rendering control.
  const reconciler = TuiReconciler as typeof TuiReconciler & {
    /** Synchronously update the container (unlike updateContainer which is async) */
    updateContainerSync: typeof TuiReconciler.updateContainer
    /** Flush all pending synchronous work */
    flushSyncWork: () => void
    /** Flush passive effects (useEffect, useSyncExternalStore subscriptions) */
    flushPassiveEffects: () => boolean
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

  /** Find Static element and reset its committedCount for full re-render */
  const resetStaticCommittedCount = (): void => {
    if (!container.root) return

    // Walk the tree to find Static element
    const findStatic = (
      node: TuiStaticElement | { children?: unknown[] },
    ): TuiStaticElement | null => {
      if (isStaticElement(node as TuiStaticElement)) {
        return node as TuiStaticElement
      }
      if ('children' in node && Array.isArray(node.children)) {
        for (const child of node.children) {
          const found = findStatic(child as { children?: unknown[] })
          if (found) return found
        }
      }
      return null
    }

    const staticEl = findStatic(container.root as unknown as { children?: unknown[] })
    if (staticEl) {
      staticEl.committedCount = 0
    }
  }

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

    // Self-correcting resize detection: if width changed, reset everything
    // This prevents ghost lines from differential rendering with stale positions
    if (width !== lastRenderedWidth) {
      lastRenderedWidth = width
      resetStaticCommittedCount()
      staticLineCount = 0
      renderer.reset()
    }

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

  /**
   * Flush pending React work and render the current state synchronously.
   *
   * This is critical for progressive output modes (tty, ci) where we need to ensure
   * all state changes are reflected in the output before unmounting. The flush process:
   *
   * 1. Flush passive effects - ensures useSyncExternalStore subscriptions are set up
   * 2. Flush sync work - processes any pending React updates
   * 3. Force re-render - triggers React to read the latest store values
   * 4. Render to terminal - outputs the final state
   *
   * Note: Simply flushing React work isn't enough because useSyncExternalStore
   * may have received change notifications that scheduled updates at a priority
   * level not covered by flushSyncWork. Re-rendering the same element forces
   * React to call getSnapshot() again and render with the current state.
   */
  const doFlush = (): void => {
    if (disposed) return

    // Step 1: Flush passive effects (useEffect callbacks, subscription setup)
    reconciler.flushPassiveEffects()
    // Step 2: Flush any synchronous work that was scheduled
    reconciler.flushSyncWork()

    // Step 3: Force React to re-render with current external store state.
    // When useSyncExternalStore's onStoreChange callback is invoked, React schedules
    // an update, but this update may not be flushed by flushSyncWork alone.
    // By calling updateContainerSync with the same element, we force React to
    // re-execute the component and call getSnapshot() to get the latest value.
    if (lastRenderedElement) {
      reconciler.updateContainerSync(
        wrapWithProviders(lastRenderedElement),
        fiberRoot,
        null,
        () => {},
      )
      reconciler.flushSyncWork()
    }

    // Cancel any pending throttled render since we're rendering now
    pendingRender = false
    renderScheduled = false

    // Step 4: Render the React tree to terminal output
    doRender()
    lastRenderTime = Date.now()
  }

  return {
    render: (element: ReactElement) => {
      // Store for re-rendering in flush()
      lastRenderedElement = element
      // Use updateContainerSync for synchronous rendering
      // This ensures the render completes before returning, which is needed
      // for proper flush behavior in progressive modes
      reconciler.updateContainerSync(wrapWithProviders(element), fiberRoot, null, () => {})
      reconciler.flushSyncWork()
    },
    unmount: (options?: UnmountOptions) => {
      // Flush pending React work and render final state before unmounting
      // This ensures all dispatched state updates are visible in the output
      doFlush()

      // Mark as disposed to prevent any more renders
      disposed = true
      // Dispose renderer (preserves content for persist mode)
      renderer.dispose({ mode: options?.mode ?? 'persist' })
      // Clean up React internals (won't trigger render due to disposed flag)
      reconciler.updateContainerSync(null, fiberRoot, null, () => {})
      reconciler.flushSyncWork()
    },
    flush: doFlush,
    resize: () => {
      // Just schedule a render - doRender() will detect the width change
      // and self-correct by resetting state if needed
      if (!disposed) scheduleRender()
    },
    get viewport() {
      return viewport
    },
  }
}
