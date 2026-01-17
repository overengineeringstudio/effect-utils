/**
 * Check task orchestrator - runs all checks using the task system.
 */

import { cpus } from 'node:os'

import { Effect } from 'effect'

import { task } from '../task-system/api.ts'
import { runTaskGraphOrFail } from '../task-system/graph.ts'
import { ciRenderer } from '../task-system/renderers/ci.ts'
import { piTuiInlineRenderer } from '../task-system/renderers/pi-tui-inline.ts'
import type { TaskDef } from '../task-system/types.ts'
import { IS_CI } from '../utils.ts'
import { allLintChecks } from './lint.ts'
import type { CheckTasksConfig } from './types.ts'
import { resolveLocalTsc } from './typescript.ts'

/** Run all checks using task system with live progress */
export const checkAllWithTaskSystem = Effect.fn('checkAllWithTaskSystem')(function* (
  config: CheckTasksConfig,
) {
  // Task IDs for type safety
  type CheckTaskId = 'genie' | 'typecheck' | 'lint' | 'test'

  // Define individual tasks
  const genieTask = task({
    id: 'genie' as const,
    name: 'Genie check',
    command: { cmd: 'genie', args: ['--check'] },
  })

  const typecheckTask = task({
    id: 'typecheck' as const,
    name: 'Type checking',
    command: { cmd: resolveLocalTsc(), args: ['--build', 'tsconfig.all.json'] },
  })

  const lintTask = task({
    id: 'lint' as const,
    name: 'Lint (format + oxlint + genie coverage)',
    effect: allLintChecks(config),
  })

  // Parallel tasks (no dependencies)
  // Note: E and R channels are widened to unknown since tasks have heterogeneous types
  const parallelTasks: TaskDef<CheckTaskId, unknown, unknown, unknown>[] = [
    ...(config.skipGenie ? [] : [genieTask]),
    typecheckTask,
    lintTask,
  ]

  // Extract parallel task IDs for dependencies
  const parallelTaskIds = parallelTasks.map((t) => t.id)

  const testTask = task({
    id: 'test' as const,
    name: 'Tests',
    command: { cmd: 'vitest', args: ['run'] },
    options: { dependencies: parallelTaskIds },
  })

  // Sequential tasks (depend on all parallel tasks)
  const sequentialTasks: TaskDef<CheckTaskId, unknown, unknown, unknown>[] = config.skipTests
    ? []
    : [testTask]

  const allTasks = [...parallelTasks, ...sequentialTasks]

  // Select renderer based on environment
  // Limit concurrency to number of CPU cores to avoid bun cache race conditions
  const concurrency = cpus().length
  const renderer = IS_CI ? ciRenderer() : piTuiInlineRenderer()
  const result = yield* runTaskGraphOrFail({
    tasks: allTasks,
    options: {
      onStateChange: (state) => renderer.render(state),
      concurrency,
    },
  })

  yield* renderer.renderFinal(result.state)

  return result
})
