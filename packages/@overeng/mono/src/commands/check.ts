import { Command } from '@effect/cli'
import { Effect } from 'effect'

import type { CheckTasksConfig, GenieCoverageConfig } from '../tasks/mod.ts'
import { checkAllWithTaskSystem } from '../tasks/mod.ts'

/**
 * Create a check command using the task system.
 */
export const checkCommandWithTaskSystem = (config: {
  genieConfig: GenieCoverageConfig
  skipGenie?: boolean
  skipTests?: boolean
}) =>
  Command.make('check', {}, () => {
    const taskConfig: CheckTasksConfig = {
      genieConfig: config.genieConfig,
      ...(config.skipGenie !== undefined ? { skipGenie: config.skipGenie } : {}),
      ...(config.skipTests !== undefined ? { skipTests: config.skipTests } : {}),
    }
    return checkAllWithTaskSystem(taskConfig).pipe(Effect.asVoid)
  }).pipe(Command.withDescription('Run all checks (genie + typecheck + format + lint + test)'))
