import { Command } from '@effect/cli'
import { FileSystem, Path } from '@effect/platform'
import type * as CommandExecutor from '@effect/platform/CommandExecutor'
import type { PlatformError } from '@effect/platform/Error'
import { Cause, Console, Effect, Exit, Stream } from 'effect'

import { CurrentWorkingDirectory, printFinalSummary, TaskRunner } from '@overeng/utils/node'

import type { CommandError, GenieCoverageError } from '../errors.ts'
import type { GenieCoverageConfig, OxcConfig } from '../tasks.ts'
import { allLintChecks, genieCheck, testRun, typeCheck } from '../tasks.ts'
import { ciGroup, ciGroupEnd, IS_CI } from '../utils.ts'

/** Error types that check tasks can produce */
export type CheckTaskError = CommandError | GenieCoverageError | PlatformError

/** Service requirements that check tasks might need */
export type CheckTaskRequirements =
  | CommandExecutor.CommandExecutor
  | CurrentWorkingDirectory
  | FileSystem.FileSystem
  | Path.Path

/** Task definition for the check command */
export interface CheckTask {
  /** Unique identifier for the task */
  id: string
  /** Human-readable name shown in output */
  name: string
  /** The task effect to run */
  task: Effect.Effect<void, CheckTaskError, CheckTaskRequirements>
  /** Command info for TaskRunner interactive mode (optional) */
  command?: { cmd: string; args: string[] }
}

/** Configuration for the check command */
export interface CheckCommandConfig {
  /** Tasks to run in parallel */
  parallelTasks: CheckTask[]
  /** Tasks to run sequentially after parallel tasks (e.g. tests) */
  sequentialTasks?: CheckTask[]
}

/** CI mode: sequential execution with GitHub Actions groups */
export const checkCommandCI = (config: CheckCommandConfig) =>
  Effect.gen(function* () {
    yield* Console.log('Running all checks...\n')

    const exits: Exit.Exit<void, CheckTaskError>[] = []

    for (const task of config.parallelTasks) {
      yield* ciGroup(task.name)
      const exit = yield* task.task.pipe(Effect.exit)
      exits.push(exit)
      yield* ciGroupEnd
    }

    for (const task of config.sequentialTasks ?? []) {
      yield* ciGroup(task.name)
      const exit = yield* task.task.pipe(Effect.exit)
      exits.push(exit)
      yield* ciGroupEnd
    }

    const failures = exits.filter(Exit.isFailure)
    if (failures.length === 0) {
      yield* Console.log('\n✓ All checks passed')
      return
    }

    const [firstFailure, ...restFailures] = failures
    if (firstFailure === undefined) {
      yield* Console.log('\n✓ All checks passed')
      return
    }

    let combined = firstFailure.cause
    for (const failure of restFailures) {
      combined = Cause.parallel(combined, failure.cause)
    }

    return yield* Effect.failCause(combined)
  })

/** Interactive mode: concurrent execution with TaskRunner for live output */
export const checkCommandInteractive = (config: CheckCommandConfig) =>
  Effect.gen(function* () {
    const runner = yield* TaskRunner

    // Register all tasks
    for (const task of config.parallelTasks) {
      yield* runner.register({ id: task.id, name: task.name })
    }
    for (const task of config.sequentialTasks ?? []) {
      yield* runner.register({ id: task.id, name: task.name })
    }

    // Start render loop
    yield* runner.changes.pipe(
      Stream.debounce('50 millis'),
      Stream.runForEach(() =>
        Effect.gen(function* () {
          const output = yield* runner.render()
          process.stdout.write('\x1B[2J\x1B[H')
          process.stdout.write(output + '\n')
        }),
      ),
      Effect.fork,
    )

    // Run parallel tasks concurrently using TaskRunner
    yield* runner.runAll(
      config.parallelTasks
        .filter((task) => task.command !== undefined)
        .map((task) =>
          runner.runTask({ id: task.id, command: task.command!.cmd, args: task.command!.args }),
        ),
    )

    // Run sequential tasks one by one
    for (const task of config.sequentialTasks ?? []) {
      if (task.command) {
        yield* runner.runTask({ id: task.id, command: task.command.cmd, args: task.command.args })
      }
    }

    yield* printFinalSummary
  }).pipe(Effect.provide(TaskRunner.live))

/** Create a check command with automatic CI/interactive mode detection */
export const checkCommand = (config: CheckCommandConfig) =>
  Command.make('check', {}, () =>
    Effect.gen(function* () {
      if (IS_CI) {
        yield* checkCommandCI(config)
      } else {
        yield* checkCommandInteractive(config)
      }
    }),
  ).pipe(Command.withDescription('Run all checks (genie + typecheck + format + lint + test)'))

/** Create a standard check configuration for Effect monorepos */
export const createStandardCheckConfig = ({
  oxcConfig,
  genieConfig,
  extraParallelTasks,
  testTask,
  skipGenie,
  skipTests,
}: {
  oxcConfig: OxcConfig
  genieConfig: GenieCoverageConfig
  /** Additional parallel tasks */
  extraParallelTasks?: CheckTask[]
  /** Custom test task (defaults to vitest run) */
  testTask?: CheckTask
  /** Skip genie check */
  skipGenie?: boolean
  /** Skip tests */
  skipTests?: boolean
}): CheckCommandConfig =>
  ({
    parallelTasks: [
      ...(skipGenie
        ? []
        : [
            {
              id: 'genie',
              name: 'Genie check',
              task: genieCheck,
              command: { cmd: 'genie', args: ['--check'] },
            } as CheckTask,
          ]),
      {
        id: 'tsc',
        name: 'Type checking',
        task: typeCheck(),
        command: { cmd: 'tsc', args: ['--build', 'tsconfig.all.json'] },
      } as CheckTask,
      {
        id: 'lint',
        name: 'Lint (format + oxlint + genie coverage)',
        task: allLintChecks({ oxcConfig, genieConfig }),
        command: { cmd: 'mono', args: ['lint'] },
      } as CheckTask,
      ...(extraParallelTasks ?? []),
    ],
    sequentialTasks: skipTests
      ? []
      : [
          testTask ?? {
            id: 'test',
            name: 'Tests',
            task: testRun(),
            command: { cmd: 'vitest', args: ['run'] },
          },
        ],
  })
