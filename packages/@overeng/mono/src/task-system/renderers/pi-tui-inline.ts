/**
 * Pi-tui inline renderer: Terminal UI with differential rendering.
 *
 * Uses pi-tui for efficient inline rendering with:
 * - Automatic differential rendering (only changed lines)
 * - Effect-native render scheduling (not relying on process.nextTick)
 * - Proper resource cleanup (no hanging processes)
 * - Ctrl+C handling (graceful interrupt)
 *
 * Implements TaskRenderer interface for compatibility with runTaskGraph.
 */

import { Atom, Registry } from '@effect-atom/atom'
import type { TUI } from '@mariozechner/pi-tui'
import { Effect, Exit, Fiber, Scope } from 'effect'

import { RenderScheduler, type RenderSchedulerHandle, TerminalResource } from '../lib/mod.ts'
import type { TaskRenderer, TaskSystemState } from '../types.ts'
import { TaskSystemComponent } from '../ui/pi-tui/TaskSystemComponent.ts'

/** Ctrl+C character in raw mode */
const CTRL_C = '\x03'

/**
 * Internal state for the renderer.
 * Created on first render, cleaned up in renderFinal.
 */
interface RendererState {
  readonly scope: Scope.CloseableScope
  readonly tui: TUI
  readonly registry: Registry.Registry
  readonly stateAtom: Atom.Writable<TaskSystemState>
  readonly component: TaskSystemComponent
  readonly scheduler: RenderSchedulerHandle
  readonly ctrlCCleanup: () => void
}

/**
 * Pi-tui inline renderer that implements TaskRenderer interface.
 *
 * Architecture:
 * - TaskSystemState → Atom → TaskSystemComponent → Pi-tui TUI → Terminal
 * - Effect-based render scheduler (80ms interval for smooth animation)
 * - Scoped resource management for proper cleanup
 */
export class PiTuiInlineRenderer implements TaskRenderer {
  private state: RendererState | undefined
  private mainFiber: Fiber.RuntimeFiber<unknown, unknown> | undefined

  /**
   * Set the main fiber for Ctrl+C interrupt handling.
   * Must be called before render() if you want Ctrl+C to work.
   */
  setMainFiber(fiber: Fiber.RuntimeFiber<unknown, unknown>): void {
    this.mainFiber = fiber
  }

  render(taskState: TaskSystemState): Effect.Effect<void, never, never> {
    return Effect.gen(this, function* () {
      // Initialize on first render
      if (!this.state) {
        this.state = yield* this.initialize(taskState)
      } else {
        // Update state atom - render loop will pick it up
        this.state.registry.set(this.state.stateAtom, taskState)
        yield* this.state.scheduler.requestRender()
      }
    })
  }

  renderFinal(taskState: TaskSystemState): Effect.Effect<void, never, never> {
    return Effect.gen(this, function* () {
      if (!this.state) {
        return
      }

      // Final state update
      this.state.registry.set(this.state.stateAtom, taskState)

      // Force immediate final render
      yield* this.state.scheduler.forceRender()

      // Small delay to ensure render is visible
      yield* Effect.sleep('50 millis')

      // Cleanup Ctrl+C handler
      this.state.ctrlCCleanup()

      // Close scope (releases terminal, stops scheduler)
      yield* Scope.close(this.state.scope, Exit.void)

      // Clear state
      this.state = undefined
    })
  }

  /**
   * Initialize renderer resources.
   * Creates a scope and acquires all necessary resources.
   */
  private initialize(initialState: TaskSystemState): Effect.Effect<RendererState, never, never> {
    return Effect.gen(this, function* () {
      // Create a closeable scope for resource management
      const scope = yield* Scope.make()

      // Acquire terminal resource
      const { tui } = yield* TerminalResource.pipe(Effect.provideService(Scope.Scope, scope))

      // Setup atom registry
      const registry = Registry.make()
      const stateAtom = Atom.make(initialState)

      // Create component
      const component = new TaskSystemComponent({
        stateAtom,
        registry,
      })

      // Add component to TUI
      tui.addChild(component)

      // Create render scheduler (80ms interval for smooth spinner)
      const scheduler = yield* RenderScheduler.make(tui, {
        intervalMs: 80,
      }).pipe(Effect.provideService(Scope.Scope, scope))

      // Set TUI reference for component (starts spinner animation requests)
      component.setTui(tui)

      // Install Ctrl+C handler
      const ctrlCCleanup = this.installCtrlCHandler()

      // Add cleanup for registry and component to scope
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          component.dispose()
          registry.dispose()
        }),
      )

      return {
        scope,
        tui,
        registry,
        stateAtom,
        component,
        scheduler,
        ctrlCCleanup,
      }
    })
  }

  /**
   * Install Ctrl+C handler that interrupts the main fiber or exits gracefully.
   * Returns cleanup function.
   *
   * In raw mode, Ctrl+C is captured as \x03 instead of sending SIGINT.
   * If setMainFiber was called, we interrupt that fiber.
   * Otherwise, we cleanup and exit with code 130 (standard SIGINT exit code).
   */
  private installCtrlCHandler(): () => void {
    const handler = (data: string) => {
      if (data === CTRL_C) {
        if (this.mainFiber) {
          // Interrupt the main fiber gracefully
          Effect.runFork(Fiber.interrupt(this.mainFiber))
        } else {
          // Fallback: cleanup and exit
          // Show cursor and pause stdin before exiting
          process.stdout.write('\x1b[?25h') // CURSOR_SHOW
          process.stdin.pause()
          // Exit with SIGINT code (128 + 2)
          process.exit(130)
        }
      }
    }

    process.stdin.on('data', handler)

    return () => {
      process.stdin.off('data', handler)
    }
  }
}

/**
 * Create a pi-tui inline renderer instance.
 */
export const piTuiInlineRenderer = (): PiTuiInlineRenderer => new PiTuiInlineRenderer()
