import { Command, Options } from '@effect/cli'
import { unicodeSymbols } from '@overeng/tui-core'
import { Console, Effect } from 'effect'

import { ciGroup, ciGroupEnd, IS_CI, runCommand } from '../utils.ts'

const unitOption = Options.boolean('unit').pipe(
  Options.withAlias('u'),
  Options.withDescription('Run only unit tests'),
  Options.withDefault(false),
)

const integrationOption = Options.boolean('integration').pipe(
  Options.withAlias('i'),
  Options.withDescription('Run only integration tests (Playwright)'),
  Options.withDefault(false),
)

const watchOption = Options.boolean('watch').pipe(
  Options.withAlias('w'),
  Options.withDescription('Run in watch mode'),
  Options.withDefault(false),
)

/** Create a test command */
export const testCommand = () =>
  Command.make(
    'test',
    { unit: unitOption, integration: integrationOption, watch: watchOption },
    Effect.fn('mono.test')(function* ({ unit, integration, watch }) {
      const watchArg = watch && !IS_CI ? [] : ['run']
      const reporterArgs = IS_CI ? ['--reporter=verbose'] : []

      if (unit) {
        yield* ciGroup('Running unit tests')
        yield* runCommand({
          command: 'vitest',
          args: [...watchArg, ...reporterArgs],
        })
        yield* ciGroupEnd
      } else if (integration) {
        yield* ciGroup('Running integration tests')
        yield* runCommand({
          command: 'vitest',
          args: [...watchArg, ...reporterArgs],
        })
        yield* ciGroupEnd
        yield* ciGroup('Running Playwright tests')
        yield* runCommand({ command: 'playwright', args: ['test'] })
        yield* ciGroupEnd
      } else {
        yield* ciGroup('Running all tests')
        yield* runCommand({
          command: 'vitest',
          args: [...watchArg, ...reporterArgs],
        })
        yield* ciGroupEnd
      }

      yield* Console.log(`${unicodeSymbols.status.check} Tests complete`)
    }),
  ).pipe(Command.withDescription('Run tests'))
