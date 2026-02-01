/**
 * Inline terminal renderer with differential updates and static/dynamic regions.
 *
 * Key features:
 * - Renders within normal scrollback (not alternate screen)
 * - Supports static region (logs) that persists above dynamic region (progress)
 * - Uses differential rendering to minimize flicker
 * - Supports synchronized output (CSI 2026) for atomic updates
 *
 * Debug mode: Set TUI_DEBUG=1 environment variable to see render state on stderr.
 */

// Check if debug mode is enabled
const DEBUG = typeof process !== 'undefined' && process.env?.TUI_DEBUG === '1'

// Global render counter for debugging
let globalRenderCount = 0
let globalInstanceCount = 0

import {
  beginSyncOutput,
  clearLine,
  clearScreenAndHome,
  cursorToColumn,
  cursorUp,
  endSyncOutput,
  hideCursor,
  showCursor,
} from './ansi.ts'
import type { Terminal } from './terminal.ts'

/** Options for InlineRenderer */
export interface InlineRendererOptions {
  /** Whether to use synchronized output (CSI 2026). Default: true */
  syncOutput?: boolean | undefined
  /** Whether to hide cursor during rendering. Default: true */
  hideCursor?: boolean | undefined
}

/**
 * Exit mode for dispose behavior.
 * - `persist`: Keep all output visible (final render stays)
 * - `clear`: Remove all output (both static and dynamic)
 * - `clearDynamic`: Keep static logs, clear dynamic region
 */
export type ExitMode = 'persist' | 'clear' | 'clearDynamic'

/** Options for dispose */
export interface DisposeOptions {
  /** Exit mode controlling what happens to rendered output. Default: 'persist' */
  mode?: ExitMode
}

/**
 * Inline terminal renderer with static and dynamic regions.
 *
 * Static region: Content that persists (like logs). New static content is appended
 * above the dynamic region and never re-rendered.
 *
 * Dynamic region: Content that updates in place (like progress). Uses differential
 * rendering to only update changed lines.
 *
 * ```
 * ┌────────────────────────────────────────────────┐
 * │ [INFO] Starting sync...                        │ ← Static region
 * │ [WARN] effect-utils: Missing lockfile          │   (grows downward)
 * ├────────────────────────────────────────────────┤
 * │ ● Syncing repositories...                      │ ← Dynamic region
 * │   ✓ effect                                     │   (updated in place)
 * │   ◐ livestore                                  │
 * └────────────────────────────────────────────────┘
 * ```
 */
export class InlineRenderer {
  private readonly terminal: Terminal
  private readonly options: Required<InlineRendererOptions>

  /** Lines that have been committed to the static region */
  private staticLines: string[] = []

  /** Current dynamic lines being rendered */
  private dynamicLines: string[] = []

  /** Previous dynamic lines (for diff computation) */
  private previousDynamic: string[] = []

  /** Whether we've done the initial render */
  private hasRendered = false

  /** Whether cursor is currently hidden */
  private cursorHidden = false

  /** Instance ID for debugging */
  private readonly instanceId: number

  constructor({ terminal, options = {} }: { terminal: Terminal; options?: InlineRendererOptions }) {
    this.terminal = terminal
    this.options = {
      syncOutput: options.syncOutput ?? true,
      hideCursor: options.hideCursor ?? true,
    }
    this.instanceId = ++globalInstanceCount
    if (DEBUG) {
      console.error(
        `[TUI_DEBUG] InlineRenderer created: instance=${this.instanceId} isTTY=${terminal.isTTY} cols=${terminal.columns} rows=${terminal.rows}`,
      )
    }
  }

  /**
   * Append content to the static region.
   *
   * This content will be printed immediately above the dynamic region.
   * Lines should already be truncated by the caller.
   */
  appendStatic(lines: readonly string[]): void {
    if (lines.length === 0) return

    // If we have dynamic content, we need to clear it first, print static, then re-render dynamic
    if (this.hasRendered && this.dynamicLines.length > 0) {
      this.clearDynamic()
    }

    // Print the new static lines
    for (const line of lines) {
      this.terminal.write(line + '\r\n')
    }
    this.staticLines.push(...lines)

    // Re-render dynamic content below the new static content
    if (this.hasRendered && this.dynamicLines.length > 0) {
      this.previousDynamic = [] // Force full re-render
      this.renderDynamic()
    }
  }

  /**
   * Render dynamic content.
   *
   * This content updates in place below the static region.
   * Uses differential rendering to minimize output.
   * Lines should already be truncated by the caller.
   */
  render(lines: readonly string[]): void {
    this.dynamicLines = [...lines]
    this.renderDynamic()
  }

  /**
   * Clean up and optionally clear output based on exit mode.
   *
   * @param options - Dispose options
   * @param options.mode - Exit mode:
   *   - `persist` (default): Keep all output visible
   *   - `clear`: Remove all output (static and dynamic)
   *   - `clearDynamic`: Keep static logs, clear dynamic region
   */
  dispose(options: DisposeOptions = {}): void {
    const mode = options.mode ?? 'persist'

    if (this.terminal.isTTY) {
      switch (mode) {
        case 'persist':
          // Keep everything as-is, just show cursor
          break

        case 'clear':
          // Clear both dynamic and static regions
          if (this.hasRendered && this.dynamicLines.length > 0) {
            this.clearDynamic()
          }
          // Clear static lines by moving up and clearing each line
          if (this.staticLines.length > 0) {
            this.clearStaticLines()
          }
          break

        case 'clearDynamic':
          // Clear only dynamic region, keep static
          if (this.hasRendered && this.dynamicLines.length > 0) {
            this.clearDynamic()
          }
          break
      }
    }

    // Always restore cursor visibility
    if (this.cursorHidden) {
      this.terminal.write(showCursor())
      this.cursorHidden = false
    }
  }

  /** Get current static lines (for testing) */
  getStaticLines(): readonly string[] {
    return this.staticLines
  }

  /** Get current dynamic lines (for testing) */
  getDynamicLines(): readonly string[] {
    return this.dynamicLines
  }

  /**
   * Reset the renderer state, clearing all content from the terminal.
   *
   * This is used during resize to start fresh. After calling reset(),
   * the next render will be treated as the first render.
   *
   * Uses clearScreenAndHome() instead of line-by-line clearing because
   * terminal reflow during resize invalidates cursor position assumptions.
   */
  reset(): void {
    if (DEBUG) {
      console.error(
        `[TUI_DEBUG] reset() called: instance=${this.instanceId} hadRendered=${this.hasRendered} staticLines=${this.staticLines.length} dynamicLines=${this.dynamicLines.length}`,
      )
    }
    if (this.terminal.isTTY) {
      // Clear entire screen - line-by-line clearing doesn't work after reflow
      this.terminal.write(clearScreenAndHome())
    }

    // Reset internal state
    this.staticLines = []
    this.dynamicLines = []
    this.previousDynamic = []
    this.hasRendered = false
  }

  // ===========================================================================
  // Private methods
  // ===========================================================================

  private renderDynamic(): void {
    const renderNum = ++globalRenderCount
    if (DEBUG) {
      console.error(
        `[TUI_DEBUG] renderDynamic #${renderNum}: instance=${this.instanceId} isTTY=${this.terminal.isTTY} hasRendered=${this.hasRendered} prevLines=${this.previousDynamic.length} currLines=${this.dynamicLines.length}`,
      )
    }

    if (!this.terminal.isTTY) {
      // Non-TTY: just print lines (no cursor control available)
      if (DEBUG) {
        console.error(
          `[TUI_DEBUG] #${renderNum}: Taking NON-TTY path (isTTY=${this.terminal.isTTY})`,
        )
      }
      for (const line of this.dynamicLines) {
        this.terminal.write(line + '\r\n')
      }
      this.hasRendered = true
      return
    }

    // Hide cursor during render
    if (this.options.hideCursor && !this.cursorHidden) {
      this.terminal.write(hideCursor())
      this.cursorHidden = true
    }

    // Begin synchronized output
    if (this.options.syncOutput) {
      this.terminal.write(beginSyncOutput())
    }

    try {
      if (!this.hasRendered) {
        // First render: just output all lines
        if (DEBUG) {
          console.error(`[TUI_DEBUG] #${renderNum}: Taking FIRST-RENDER path (hasRendered=false)`)
        }
        this.renderAllDynamic()
      } else {
        // Subsequent render: use differential update
        if (DEBUG) {
          console.error(`[TUI_DEBUG] #${renderNum}: Taking DIFFERENTIAL path (hasRendered=true)`)
        }
        this.renderDifferential()
      }
    } finally {
      // End synchronized output
      if (this.options.syncOutput) {
        this.terminal.write(endSyncOutput())
      }
    }

    this.previousDynamic = [...this.dynamicLines]
    this.hasRendered = true
  }

  private renderAllDynamic(): void {
    for (const line of this.dynamicLines) {
      // Use \r\n to ensure cursor returns to column 0 (xterm.js treats \n as line feed only)
      this.terminal.write(line + '\r\n')
    }
  }

  private renderDifferential(): void {
    const prev = this.previousDynamic
    const curr = this.dynamicLines
    const prevLen = prev.length
    const currLen = curr.length

    // Find first differing line
    let firstDiff = 0
    while (firstDiff < prevLen && firstDiff < currLen && prev[firstDiff] === curr[firstDiff]) {
      firstDiff++
    }

    // If nothing changed, nothing to do
    if (firstDiff === prevLen && firstDiff === currLen) {
      if (DEBUG) {
        console.error(`[TUI_DEBUG] renderDifferential: NO CHANGES, skipping`)
      }
      return
    }

    // Move cursor to first differing line
    const linesToMoveUp = prevLen - firstDiff
    if (DEBUG) {
      console.error(
        `[TUI_DEBUG] renderDifferential: firstDiff=${firstDiff} prevLen=${prevLen} currLen=${currLen} linesToMoveUp=${linesToMoveUp}`,
      )
    }
    if (linesToMoveUp > 0) {
      this.terminal.write(cursorUp(linesToMoveUp))
    }

    // Clear and rewrite from firstDiff onwards
    for (let i = firstDiff; i < currLen; i++) {
      this.terminal.write(cursorToColumn(1) + clearLine() + curr[i] + '\r\n')
    }

    // If new content is shorter, clear remaining old lines
    if (currLen < prevLen) {
      const extraLines = prevLen - currLen
      for (let i = 0; i < extraLines; i++) {
        this.terminal.write(clearLine() + '\r\n')
      }
      // Move cursor back up to end of new content
      this.terminal.write(cursorUp(extraLines))
    }
  }

  private clearDynamic(): void {
    if (!this.terminal.isTTY || this.previousDynamic.length === 0) return

    // Move to start of dynamic region and clear all lines
    const linesToClear = this.previousDynamic.length
    this.terminal.write(cursorUp(linesToClear))
    for (let i = 0; i < linesToClear; i++) {
      this.terminal.write(clearLine() + '\r\n')
    }
    this.terminal.write(cursorUp(linesToClear))
    this.previousDynamic = []
  }

  private clearStaticLines(): void {
    if (!this.terminal.isTTY || this.staticLines.length === 0) return

    // Move up past all static lines and clear them
    const linesToClear = this.staticLines.length
    this.terminal.write(cursorUp(linesToClear))
    for (let i = 0; i < linesToClear; i++) {
      this.terminal.write(clearLine() + '\r\n')
    }
    this.terminal.write(cursorUp(linesToClear))
    this.staticLines = []
  }
}
