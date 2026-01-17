/**
 * Root pi-tui component for task system rendering.
 *
 * Implements the pi-tui Component interface and manages:
 * - Task list rendering
 * - Spinner animation (frame incremented on each render)
 * - State updates via atom/registry
 *
 * Note: Spinner timing is controlled by the RenderScheduler (80ms interval),
 * not by this component. We just increment the frame on each render() call.
 */

import type { Atom, Registry } from '@effect-atom/atom'
import type { Component, TUI } from '@mariozechner/pi-tui'

import type { TaskSystemState } from '../../types.ts'
import { renderTask } from './TaskComponent.ts'

/**
 * Pi-tui component for rendering the task system.
 *
 * Features:
 * - Two-column layout (status | log)
 * - Animated spinner for running tasks (frame advances each render)
 * - Padding around task list
 * - Differential rendering (pi-tui handles automatically)
 */
export class TaskSystemComponent implements Component {
  private spinnerFrame = 0
  private stateAtom: Atom.Atom<TaskSystemState>
  private registry: Registry.Registry
  private tui: TUI | undefined
  private atomUnmount: () => void

  constructor({
    stateAtom,
    registry,
  }: {
    stateAtom: Atom.Atom<TaskSystemState>
    registry: Registry.Registry
  }) {
    this.stateAtom = stateAtom
    this.registry = registry

    // CRITICAL: Mount the atom to prevent it from being garbage collected.
    // Without this, the atom node is removed after each microtask since it has
    // no listeners, causing subsequent reads to return the initial value.
    this.atomUnmount = registry.mount(stateAtom)
  }

  /**
   * Set TUI reference (kept for API compatibility).
   * Previously used for spinner interval, now just stores reference.
   */
  setTui(tui: TUI): void {
    this.tui = tui
  }

  /** Required by pi-tui Component interface. */
  invalidate(): void {
    // No-op: we always render fresh output in render()
  }

  /**
   * Check if any tasks are actively running or pending.
   */
  private hasActiveTasks(state: TaskSystemState): boolean {
    return Object.values(state.tasks).some(
      (task) => task.status === 'running' || task.status === 'pending',
    )
  }

  /**
   * Render the task system UI.
   *
   * Increments spinner frame on each call (timing controlled by RenderScheduler).
   * Returns array of lines (each line must be ≤ width).
   */
  render(width: number): string[] {
    const state = this.registry.get(this.stateAtom)

    // Advance spinner frame only if there are active tasks
    if (this.hasActiveTasks(state)) {
      this.spinnerFrame = (this.spinnerFrame + 1) % 10
    }

    const tasks = Object.values(state.tasks)

    return [
      '', // Top padding
      ...tasks.map((task) =>
        renderTask({ task, spinnerFrame: this.spinnerFrame, width: width - 2 }),
      ),
      '', // Bottom padding
    ]
  }

  /**
   * Cleanup resources (called by renderer on shutdown).
   */
  dispose(): void {
    this.atomUnmount()
  }
}
