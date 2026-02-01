import { Command, Options } from '@effect/cli'
import { unicodeSymbols } from '@overeng/tui-core'
import { Console, Effect } from 'effect'

import type { TypeCheckConfig } from '../tasks/mod.ts'
import { typeCheck, typeCheckClean, typeCheckWatch } from '../tasks/mod.ts'
import { ciGroup, ciGroupEnd } from '../utils.ts'

const watchOption = Options.boolean('watch').pipe(
  Options.withAlias('w'),
  Options.withDescription('Run in watch mode'),
  Options.withDefault(false),
)

const cleanOption = Options.boolean('clean').pipe(
  Options.withAlias('c'),
  Options.withDescription('Remove build artifacts before type checking'),
  Options.withDefault(false),
)

/** Create a TypeScript check command */
export const tsCommand = (config?: TypeCheckConfig) =>
  Command.make(
    'ts',
    { watch: watchOption, clean: cleanOption },
    Effect.fn('mono.ts')(function* ({ watch, clean }) {
      if (clean) {
        yield* ciGroup('Cleaning build artifacts')
        yield* typeCheckClean(config)
        yield* ciGroupEnd
      }

      if (watch) {
        yield* Console.log('Starting TypeScript watch mode...')
        yield* typeCheckWatch(config)
      } else {
        yield* ciGroup('Type checking')
        yield* typeCheck(config)
        yield* ciGroupEnd
        yield* Console.log(`${unicodeSymbols.status.check} Type check complete`)
      }
    }),
  ).pipe(Command.withDescription('Run TypeScript type checking'))
