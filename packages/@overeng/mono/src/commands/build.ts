import { Command } from '@effect/cli'
import { Console, Effect } from 'effect'

import { unicodeSymbols } from '@overeng/tui-core'

import type { TypeCheckConfig } from '../tasks/mod.ts'
import { build } from '../tasks/mod.ts'
import { ciGroup, ciGroupEnd } from '../utils.ts'

/** Create a build command */
export const buildCommand = (config?: TypeCheckConfig) =>
  Command.make(
    'build',
    {},
    Effect.fn('mono.build')(function* () {
      yield* ciGroup('Building all packages')
      yield* build(config)
      yield* ciGroupEnd
      yield* Console.log(`${unicodeSymbols.status.check} Build complete`)
    }),
  ).pipe(Command.withDescription('Build all packages (tsc --build)'))
