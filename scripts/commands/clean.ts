import { Command } from '@effect/cli'
import { Console, Effect } from 'effect'

import { ciGroup, ciGroupEnd, runCommand } from './utils.js'

export const cleanCommand = Command.make('clean', {}, () =>
  Effect.gen(function* () {
    yield* ciGroup('Cleaning build artifacts')

    yield* Console.log('Removing dist directories...')
    yield* runCommand({
      command: 'find',
      args: ['.', '-type', 'd', '-name', 'dist', '-prune', '-exec', 'rm', '-rf', '{}', '+'],
    })

    yield* Console.log('Removing .tsbuildinfo files...')
    yield* runCommand({ command: 'find', args: ['.', '-name', '*.tsbuildinfo', '-delete'] })

    yield* Console.log('Removing storybook-static directories...')
    yield* runCommand({
      command: 'find',
      args: [
        '.',
        '-type',
        'd',
        '-name',
        'storybook-static',
        '-prune',
        '-exec',
        'rm',
        '-rf',
        '{}',
        '+',
      ],
    })

    yield* ciGroupEnd
    yield* Console.log('✓ Clean complete')
  }),
).pipe(Command.withDescription('Remove build artifacts (dist, .tsbuildinfo, etc.)'))
