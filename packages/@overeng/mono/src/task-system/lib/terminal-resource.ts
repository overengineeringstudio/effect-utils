/**
 * Effect-managed terminal resource for pi-tui.
 *
 * Provides proper acquire/release lifecycle management for pi-tui TUI instances.
 * Ensures cleanup (cursor restored, stdin paused) even on errors or interrupts.
 */

import { ProcessTerminal, TUI } from '@mariozechner/pi-tui'
import type { Scope } from 'effect'
import { Effect } from 'effect'

/** ANSI escape codes */
const CURSOR_HIDE = '\x1b[?25l'
const CURSOR_SHOW = '\x1b[?25h'

/**
 * Terminal resource state returned by acquire.
 */
export interface TerminalState {
  readonly terminal: ProcessTerminal
  readonly tui: TUI
}

/**
 * Acquire a pi-tui terminal and TUI instance.
 *
 * - Hides cursor
 * - Creates ProcessTerminal and TUI
 * - Starts TUI
 *
 * Must be used with Effect.scoped or Scope to ensure cleanup.
 */
const acquire = Effect.sync((): TerminalState => {
  // Hide cursor during rendering
  process.stdout.write(CURSOR_HIDE)

  // Create terminal and TUI
  const terminal = new ProcessTerminal()
  const tui = new TUI(terminal)

  // Start TUI (this sets up stdin handlers)
  tui.start()

  return { terminal, tui }
})

/**
 * Release a pi-tui terminal and TUI instance.
 *
 * - Stops TUI
 * - Shows cursor
 * - Pauses stdin (critical to prevent process hanging)
 */
const release = (state: TerminalState) =>
  Effect.sync(() => {
    // Stop TUI (cleans up resize handlers, etc.)
    state.tui.stop()

    // Show cursor
    process.stdout.write(CURSOR_SHOW)

    // Critical: pause stdin to allow process to exit
    // Pi-tui calls process.stdin.resume() but doesn't pause on stop
    process.stdin.pause()
  })

/**
 * Scoped terminal resource.
 *
 * Usage:
 * ```ts
 * Effect.scoped(
 *   Effect.gen(function* () {
 *     const { tui } = yield* TerminalResource;
 *     // Use tui...
 *   })
 * )
 * ```
 */
export const TerminalResource: Effect.Effect<TerminalState, never, Scope.Scope> =
  Effect.acquireRelease(acquire, release)

/**
 * Create a terminal resource with custom acquire/release hooks.
 * Useful for testing or adding additional setup/teardown logic.
 */
export const makeTerminalResource = ({
  onAcquire,
  onRelease,
}: {
  onAcquire?: () => void
  onRelease?: () => void
} = {}): Effect.Effect<TerminalState, never, Scope.Scope> =>
  Effect.acquireRelease(
    acquire.pipe(Effect.tap(() => (onAcquire ? Effect.sync(onAcquire) : Effect.void))),
    (state) =>
      release(state).pipe(Effect.tap(() => (onRelease ? Effect.sync(onRelease) : Effect.void))),
  )
