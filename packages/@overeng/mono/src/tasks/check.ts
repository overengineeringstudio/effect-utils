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
    effect: allLintChecks({ oxcConfig: config.oxcConfig, genieConfig: config.genieConfig }),
  })

  // Test task depends on all parallel tasks
  const testTask = task({
    id: 'test' as const,
    name: 'Tests',
    command: { cmd: 'vitest', args: ['run'] },
    options: { dependencies: ['genie', 'typecheck', 'lint'] as const },
  })

  // All tasks defined - filter based on config
  const allTasksDefined = [genieTask, typecheckTask, lintTask, testTask] as const
  const allTasks = allTasksDefined.filter(
    (t) => !(config.skipGenie && t.id === 'genie') && !(config.skipTests && t.id === 'test'),
  )

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
