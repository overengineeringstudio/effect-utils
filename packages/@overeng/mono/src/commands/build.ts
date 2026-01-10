import { Command } from '@effect/cli'
import { Console, Effect } from 'effect'

import type { TypeCheckConfig } from '../tasks.ts'
import { build } from '../tasks.ts'
import { ciGroup, ciGroupEnd } from '../utils.ts'

/** Create a build command */
export const buildCommand = (config?: TypeCheckConfig) =>
  Command.make('build', {}, () =>
    Effect.gen(function* () {
      yield* ciGroup('Building all packages')
      yield* build(config)
      yield* ciGroupEnd
      yield* Console.log('✓ Build complete')
    }),
  ).pipe(Command.withDescription('Build all packages (tsc --build)'))
