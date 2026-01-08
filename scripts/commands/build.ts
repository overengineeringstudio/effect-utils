import { Command } from '@effect/cli'
import { Console, Effect } from 'effect'

import { ciGroup, ciGroupEnd, runCommand } from './utils.js'

export const buildCommand = Command.make('build', {}, () =>
  Effect.gen(function* () {
    yield* ciGroup('Building all packages')
    yield* runCommand({ command: 'tsc', args: ['--build', 'tsconfig.all.json'] })
    yield* ciGroupEnd
    yield* Console.log('✓ Build complete')
  }),
).pipe(Command.withDescription('Build all packages in the monorepo'))
