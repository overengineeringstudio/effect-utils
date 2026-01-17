/**
 * Check task orchestrator - runs all checks using the task system.
 */

import { cpus } from 'node:os'

import { Effect } from 'effect'

import { task } from '../task-system/api.ts'
import { runTaskGraphOrFail } from '../task-system/graph.ts'
import { ciRenderer } from '../task-system/renderers/ci.ts'
import { piTuiInlineRenderer } from '../task-system/renderers/pi-tui-inline.ts'
import { IS_CI } from '../utils.ts'
import { allLintChecks } from './lint.ts'
import type { CheckTasksConfig } from './types.ts'
import { resolveLocalTsc } from './typescript.ts'

/** Run all checks using task system with live progress */
export const checkAllWithTaskSystem = Effect.fn('checkAllWithTaskSystem')(function* (
  config: CheckTasksConfig,
) {
  // Define parallel tasks (no dependencies)
  const parallelTasks = [
    ...(config.skipGenie
      ? []
      : [
          task({
            id: 'genie',
            name: 'Genie check',
            command: {
              cmd: 'genie',
              args: ['--check'],
            },
          }),
        ]),
    task({
      id: 'typecheck',
      name: 'Type checking',
      command: {
        cmd: resolveLocalTsc(),
        args: ['--build', 'tsconfig.all.json'],
      },
    }),
    task({
      id: 'lint',
      name: 'Lint (format + oxlint + genie coverage)',
      effect: allLintChecks(config),
    }),
  ]

  // Extract parallel task IDs for dependencies
  const parallelTaskIds = parallelTasks.map((t) => t.id)

  // Define sequential tasks (depend on all parallel tasks)
  const sequentialTasks = config.skipTests
    ? []
    : [
        task({
          id: 'test',
          name: 'Tests',
          command: {
            cmd: 'vitest',
            args: ['run'],
          },
          options: { dependencies: parallelTaskIds },
        }),
      ]

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
