/**
 * Inline terminal renderer with differential updates and static/dynamic regions.
 *
 * Key features:
 * - Renders within normal scrollback (not alternate screen)
 * - Supports static region (logs) that persists above dynamic region (progress)
 * - Uses differential rendering to minimize flicker
 * - Supports synchronized output (CSI 2026) for atomic updates
 */

import {
  beginSyncOutput,
  clearLine,
  clearLinesAbove,
  cursorToColumn,
  cursorUp,
  endSyncOutput,
  hideCursor,
  showCursor,
} from './ansi.ts'
import { createTerminal, type Terminal, type TerminalLike } from './terminal.ts'

/** Options for InlineRenderer */
export interface InlineRendererOptions {
  /** Whether to use synchronized output (CSI 2026). Default: true */
  syncOutput?: boolean | undefined
  /** Whether to hide cursor during rendering. Default: true */
  hideCursor?: boolean | undefined
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

  /** Previous terminal width (to detect resize) */
  private previousWidth: number

  /** Whether we've done the initial render */
  private hasRendered = false

  /** Whether cursor is currently hidden */
  private cursorHidden = false

  constructor(terminalOrStream: Terminal | TerminalLike, options: InlineRendererOptions = {}) {
    this.terminal = 'isTTY' in terminalOrStream && typeof terminalOrStream.columns === 'number'
      ? (terminalOrStream as Terminal)
      : createTerminal(terminalOrStream as TerminalLike)

    this.options = {
      syncOutput: options.syncOutput ?? true,
      hideCursor: options.hideCursor ?? true,
    }
    this.previousWidth = this.terminal.columns
  }

  /**
   * Append content to the static region.
   *
   * This content will be printed immediately above the dynamic region
   * and will never be re-rendered or cleared.
   */
  appendStatic(lines: readonly string[]): void {
    if (lines.length === 0) return

    // If we have dynamic content, we need to clear it first, print static, then re-render dynamic
    if (this.hasRendered && this.dynamicLines.length > 0) {
      this.clearDynamic()
    }

    // Print the new static lines
    for (const line of lines) {
      this.terminal.write(line + '\n')
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
   */
  render(lines: readonly string[]): void {
    this.dynamicLines = [...lines]

    // Check for terminal resize
    const currentWidth = this.terminal.columns
    if (currentWidth !== this.previousWidth) {
      this.previousWidth = currentWidth
      this.previousDynamic = [] // Force full re-render on resize
    }

    this.renderDynamic()
  }

  /**
   * Clear all dynamic content and show cursor.
   * Call this before exiting.
   */
  dispose(): void {
    if (this.hasRendered && this.dynamicLines.length > 0) {
      this.clearDynamic()
    }
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

  // ===========================================================================
  // Private methods
  // ===========================================================================

  private renderDynamic(): void {
    if (!this.terminal.isTTY) {
      // Non-TTY: just print lines
      for (const line of this.dynamicLines) {
        this.terminal.write(line + '\n')
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
        this.renderAllDynamic()
      } else {
        // Subsequent render: use differential update
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
      this.terminal.write(line + '\n')
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
      return
    }

    // Move cursor to first differing line
    const linesToMoveUp = prevLen - firstDiff
    if (linesToMoveUp > 0) {
      this.terminal.write(cursorUp(linesToMoveUp))
    }

    // Clear and rewrite from firstDiff onwards
    for (let i = firstDiff; i < currLen; i++) {
      this.terminal.write(cursorToColumn(1) + clearLine() + curr[i] + '\n')
    }

    // If new content is shorter, clear remaining old lines
    if (currLen < prevLen) {
      const extraLines = prevLen - currLen
      for (let i = 0; i < extraLines; i++) {
        this.terminal.write(clearLine() + '\n')
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
      this.terminal.write(clearLine() + '\n')
    }
    this.terminal.write(cursorUp(linesToClear))
    this.previousDynamic = []
  }
}
