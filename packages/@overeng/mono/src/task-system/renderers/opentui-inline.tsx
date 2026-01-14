/**
 * OpenTUI inline renderer: React-based terminal UI with state callback API.
 *
 * Uses OpenTUI with useAlternateScreen: false for inline rendering.
 * Implements TaskRenderer interface for compatibility with runTaskGraph.
 */

import { Atom, Registry } from '@effect-atom/atom'
import { RegistryContext } from '@effect-atom/atom-react'
import { Effect } from 'effect'

import type { TaskRenderer, TaskSystemState } from '../types.ts'
import { TaskSystemUI } from '../ui/components/TaskSystemUI.tsx'

/** ANSI escape codes for terminal control */
const CLEAR_LINE = '\x1b[2K'
const CURSOR_UP = '\x1b[1A'
const CURSOR_HIDE = '\x1b[?25l'
const CURSOR_SHOW = '\x1b[?25h'

/**
 * OpenTUI inline renderer that implements TaskRenderer interface.
 */
export class OpenTuiInlineRenderer implements TaskRenderer {
  private registry: Registry.Registry | undefined
  private stateAtom: Atom.Writable<TaskSystemState> | undefined
  private root: any | undefined
  private renderer: any | undefined
  private isFirstRender = true
  private previousLineCount = 0

  /**
   * Count expected lines for rendering (for clearing previous output).
   * This must match the actual output from TaskSystemUI.
   * With two-column layout, each task is exactly one line.
   */
  private countLines(state: TaskSystemState): number {
    const tasks = Object.values(state.tasks)
    // box padding (top + bottom) + one line per task
    return 2 + tasks.length
  }

  render(state: TaskSystemState): Effect.Effect<void> {
    return Effect.gen(
      function* (this: OpenTuiInlineRenderer) {
        // Initialize on first render
        if (this.isFirstRender) {
          // Hide cursor
          yield* Effect.sync(() => process.stdout.write(CURSOR_HIDE))

          // Setup atom registry
          this.registry = Registry.make()
          this.stateAtom = Atom.make(state)

          // Setup OpenTUI renderer (dynamic imports to avoid TS module resolution issues)
          // @ts-expect-error - OpenTUI packages have incomplete ESM type definitions
          const { createCliRenderer } = yield* Effect.promise(() => import('@opentui/core'))
          // @ts-expect-error - OpenTUI packages have incomplete ESM type definitions
          const { createRoot } = yield* Effect.promise(() => import('@opentui/react'))

          this.renderer = yield* Effect.promise(() =>
            createCliRenderer({
              useAlternateScreen: false,
              exitOnCtrlC: true,
            }),
          )
          this.root = createRoot(this.renderer)

          // Subscribe to atom changes → clear previous output and trigger re-render
          this.registry.subscribe(this.stateAtom, () => {
            // Clear previous output
            if (this.previousLineCount > 0) {
              const clearOutput = Array(this.previousLineCount)
                .fill(CURSOR_UP + CLEAR_LINE)
                .join('')
              process.stdout.write(clearOutput)
            }

            // Render new output
            this.root!.render(
              <RegistryContext.Provider value={this.registry!}>
                <TaskSystemUI atom={this.stateAtom!} />
              </RegistryContext.Provider>,
            )

            // Track line count for next clear
            const currentState = this.registry!.get(this.stateAtom!)
            this.previousLineCount = this.countLines(currentState)
          })

          // Initial render
          this.root.render(
            <RegistryContext.Provider value={this.registry}>
              <TaskSystemUI atom={this.stateAtom} />
            </RegistryContext.Provider>,
          )

          this.previousLineCount = this.countLines(state)
          this.isFirstRender = false
        } else {
          // Update state atom on subsequent renders (subscription will handle clearing + rendering)
          if (this.registry && this.stateAtom) {
            this.registry.set(this.stateAtom, state)
          }
        }
      }.bind(this),
    )
  }

  renderFinal(state: TaskSystemState): Effect.Effect<void> {
    return Effect.gen(
      function* (this: OpenTuiInlineRenderer) {
        // Final state update
        if (this.registry && this.stateAtom) {
          this.registry.set(this.stateAtom, state)
        }

        // Wait for final render to complete
        yield* Effect.sleep('100 millis')

        // Show cursor again
        yield* Effect.sync(() => process.stdout.write(CURSOR_SHOW))

        // Cleanup (CRITICAL: must call pause() due to OpenTUI bug)
        if (this.registry) this.registry.dispose()
        if (this.root) this.root.unmount()
        if (this.renderer) this.renderer.destroy()
        process.stdin.pause()
      }.bind(this),
    )
  }
}

/**
 * Create an OpenTUI inline renderer instance.
 */
export const opentuiInlineRenderer = (): TaskRenderer => new OpenTuiInlineRenderer()
