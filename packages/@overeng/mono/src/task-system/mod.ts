/**
 * Task System: Graph-based task execution with streaming output and pluggable rendering.
 *
 * @example
 * ```ts
 * import { runTaskGraphOrFail, inlineRenderer } from '@overeng/mono/task-system'
 *
 * const tasks = [
 *   { id: 'build', name: 'Build', effect: buildEffect },
 *   { id: 'test', name: 'Test', dependencies: ['build'], effect: testEffect },
 * ]
 *
 * const renderer = inlineRenderer()
 * const result = yield* runTaskGraphOrFail(tasks, {
 *   onStateChange: (state) => renderer.render(state)
 * })
 * yield* renderer.renderFinal(result.state)
 * ```
 *
 * @module
 */

// Types
export type {
  TaskDef,
  TaskEvent,
  TaskGraphResult,
  TaskRenderer,
  TaskStatus,
} from './types.ts'
export { TaskExecutionError, TaskState, TaskSystemState } from './types.ts'

// Graph execution
export { runTaskGraph, runTaskGraphOrFail } from './graph.ts'

// Renderers
export { inlineRenderer, InlineRenderer } from './renderers/inline.ts'
