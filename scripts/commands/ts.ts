import { Command, Options } from '@effect/cli'
import { Console, Effect } from 'effect'

import { ciGroup, ciGroupEnd, runCommand } from './utils.js'

const watchOption = Options.boolean('watch').pipe(
  Options.withAlias('w'),
  Options.withDescription('Run in watch mode'),
  Options.withDefault(false),
)

const cleanOption = Options.boolean('clean').pipe(
  Options.withAlias('c'),
  Options.withDescription('Clean build artifacts before compilation'),
  Options.withDefault(false),
)

/** CLI command for TypeScript type checking with optional watch mode and clean build */
export const tsCommand = Command.make(
  'ts',
  { watch: watchOption, clean: cleanOption },
  ({ watch, clean }) =>
    Effect.gen(function* () {
      if (clean) {
        yield* Console.log('Cleaning build artifacts...')
        yield* runCommand({
          command: 'find',
          args: [
            'packages',
            '-path',
            '*node_modules*',
            '-prune',
            '-o',
            '\\(',
            '-name',
            'dist',
            '-type',
            'd',
            '-o',
            '-name',
            '*.tsbuildinfo',
            '\\)',
            '-exec',
            'rm',
            '-rf',
            '{}',
            '+',
          ],
        })
      }

      yield* ciGroup('Type checking')
      const args = watch
        ? ['--build', 'tsconfig.all.json', '--watch']
        : ['--build', 'tsconfig.all.json']
      yield* runCommand({ command: 'tsc', args })
      yield* ciGroupEnd
      yield* Console.log('✓ Type check complete')
    }),
).pipe(Command.withDescription('Run TypeScript type checking'))
