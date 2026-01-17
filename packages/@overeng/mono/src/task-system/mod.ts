/**
 * Task System: Graph-based task execution with streaming output and OpenTUI rendering.
 *
 * @example
 * ```ts
 * import { runTaskGraph, opentuiRenderer } from '@overeng/mono/task-system'
 *
 * const tasks = [
 *   { id: 'build', name: 'Build', effect: buildEffect },
 *   { id: 'test', name: 'Test', dependencies: ['build'], effect: testEffect },
 * ]
 *
 * const renderer = opentuiRenderer()
 * const eventStream = yield* runTaskGraph(tasks)
 * const finalState = yield* renderer.render(eventStream)
 * yield* renderer.cleanup()
 * ```
 *
 * @module
 */

// Types
export type { TaskDef, TaskEvent, TaskGraphResult, TaskRenderer, TaskStatus } from './types.ts'
export { TaskExecutionError, TaskState, TaskSystemState } from './types.ts'

// Graph execution
export { reduceEvent, runTaskGraph, runTaskGraphOrFail } from './graph.ts'

// Renderers
export { opentuiRenderer } from './renderers/opentui.tsx'
export { opentuiInlineRenderer } from './renderers/opentui-inline.tsx'
export { piTuiInlineRenderer } from './renderers/pi-tui-inline.ts'
