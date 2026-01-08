import { Command, Options } from '@effect/cli'
import { Console, Effect } from 'effect'

import { allLintChecks, allLintFixes } from './tasks.js'
import { ciGroup, ciGroupEnd } from './utils.js'

const fixOption = Options.boolean('fix').pipe(
  Options.withAlias('f'),
  Options.withDescription('Auto-fix formatting and lint issues'),
  Options.withDefault(false),
)

export const lintCommand = Command.make('lint', { fix: fixOption }, ({ fix }) =>
  Effect.gen(function* () {
    yield* ciGroup(fix ? 'Formatting + Linting (with fixes)' : 'Formatting + Linting')
    yield* fix ? allLintFixes : allLintChecks
    yield* ciGroupEnd
    yield* Console.log('✓ Lint complete')
  }),
).pipe(Command.withDescription('Check formatting, run oxlint, and verify genie coverage'))
