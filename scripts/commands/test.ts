import { Command, Options } from '@effect/cli'
import { Console, Effect } from 'effect'

import { ciGroup, ciGroupEnd, IS_CI, runCommand } from './utils.js'

const unitOption = Options.boolean('unit').pipe(
  Options.withAlias('u'),
  Options.withDescription('Run only unit tests'),
  Options.withDefault(false),
)

const integrationOption = Options.boolean('integration').pipe(
  Options.withAlias('i'),
  Options.withDescription('Run only integration tests'),
  Options.withDefault(false),
)

const watchOption = Options.boolean('watch').pipe(
  Options.withAlias('w'),
  Options.withDescription('Run tests in watch mode'),
  Options.withDefault(false),
)

/** CLI command for running unit, integration, or all tests with optional watch mode */
export const testCommand = Command.make(
  'test',
  { unit: unitOption, integration: integrationOption, watch: watchOption },
  ({ unit, integration, watch }) =>
    Effect.gen(function* () {
      const watchArg = watch && !IS_CI ? [] : ['run']
      const reporterArgs = IS_CI ? ['--reporter=verbose'] : []

      if (unit) {
        yield* ciGroup('Running unit tests')
        yield* runCommand({
          command: 'vitest',
          args: [...watchArg, "--exclude='**/integration/**'", ...reporterArgs],
        })
        yield* ciGroupEnd
      } else if (integration) {
        yield* ciGroup('Running integration tests')
        yield* runCommand({
          command: 'vitest',
          args: [
            ...watchArg,
            'packages/@overeng/notion-effect-client/src/test/integration',
            ...reporterArgs,
          ],
        })
        yield* runCommand({
          command: 'playwright',
          args: ['test', '--config', 'packages/@overeng/utils/playwright.config.ts'],
        })
        yield* ciGroupEnd
      } else {
        yield* ciGroup('Running all tests')
        yield* runCommand({ command: 'vitest', args: [...watchArg, ...reporterArgs] })
        yield* ciGroupEnd
      }

      yield* Console.log('✓ Tests complete')
    }),
).pipe(Command.withDescription('Run tests across all packages'))
