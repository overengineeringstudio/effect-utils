import { Command, Options } from '@effect/cli'
import { unicodeSymbols } from '@overeng/tui-core'
import { Console, Effect } from 'effect'

import type { GenieCoverageConfig, OxcConfig } from '../tasks/mod.ts'
import { allLintChecks, allLintFixes } from '../tasks/mod.ts'
import { ciGroup, ciGroupEnd } from '../utils.ts'

const fixOption = Options.boolean('fix').pipe(
  Options.withAlias('f'),
  Options.withDescription('Auto-fix lint and format issues'),
  Options.withDefault(false),
)

/** Create a lint command */
export const lintCommand = ({
  oxcConfig,
  genieConfig,
}: {
  oxcConfig: OxcConfig
  genieConfig: GenieCoverageConfig
}) =>
  Command.make(
    'lint',
    { fix: fixOption },
    Effect.fn('mono.lint')(function* ({ fix }) {
      yield* ciGroup(fix ? 'Formatting + Linting (with fixes)' : 'Formatting + Linting')
      yield* fix ? allLintFixes(oxcConfig) : allLintChecks({ oxcConfig, genieConfig })
      yield* ciGroupEnd
      yield* Console.log(`${unicodeSymbols.status.check} Lint complete`)
    }),
  ).pipe(Command.withDescription('Check formatting and linting (use --fix to auto-fix)'))
