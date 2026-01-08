import { Command } from '@effect/cli'
import { Console, Effect, Stream } from 'effect'

import { printFinalSummary, TaskRunner } from '@overeng/utils/node'

import { allLintChecks, genieCheck, testRun, typeCheck } from './tasks.js'
import { ciGroup, ciGroupEnd, IS_CI } from './utils.js'

/** CI mode: sequential with groups (GitHub Actions compatible) */
const checkCommandCI = Effect.gen(function* () {
  yield* Console.log('Running all checks...\n')

  yield* ciGroup('Genie check')
  yield* genieCheck
  yield* ciGroupEnd

  yield* ciGroup('Type checking')
  yield* typeCheck
  yield* ciGroupEnd

  yield* ciGroup('Format + Lint + Genie coverage')
  yield* allLintChecks
  yield* ciGroupEnd

  yield* ciGroup('Running tests')
  yield* testRun
  yield* ciGroupEnd

  yield* Console.log('\n✓ All checks passed')
})

/** Interactive mode: concurrent with structured output via TaskRunner */
const checkCommandInteractive = Effect.gen(function* () {
  const runner = yield* TaskRunner

  yield* runner.register({ id: 'genie', name: 'Genie check' })
  yield* runner.register({ id: 'tsc', name: 'Type checking' })
  yield* runner.register({ id: 'lint', name: 'Lint (format + oxlint + genie coverage)' })
  yield* runner.register({ id: 'test', name: 'Tests' })

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

  yield* runner.runAll([
    runner.runTask({ id: 'genie', command: 'mono', args: ['genie', '--check'] }),
    runner.runTask({ id: 'tsc', command: 'tsc', args: ['--build', 'tsconfig.all.json'] }),
    runner.runTask({ id: 'lint', command: 'mono', args: ['lint'] }),
  ])

  yield* runner.runTask({ id: 'test', command: 'vitest', args: ['run'] })

  yield* printFinalSummary
}).pipe(Effect.provide(TaskRunner.live))

/**
 * Check command with structured task execution.
 * In CI mode, uses sequential execution with groups. In interactive mode, uses TaskRunner for clean output.
 */
export const checkCommand = Command.make('check', {}, () =>
  Effect.gen(function* () {
    if (IS_CI) {
      yield* checkCommandCI
    } else {
      yield* checkCommandInteractive
    }
  }),
).pipe(Command.withDescription('Run all checks (genie + typecheck + format + lint + test)'))
