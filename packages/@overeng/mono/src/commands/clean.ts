import { Command } from '@effect/cli'
import { Console, Effect } from 'effect'

import { ciGroup, ciGroupEnd, runCommand } from '../utils.ts'

/** Directories to clean (dist folders and build info) */
const CLEAN_PATTERNS = ['**/dist', '**/*.tsbuildinfo']

/** Directories to skip when cleaning */
const CLEAN_SKIP = ['node_modules', '.git', 'submodules']

/** Create a clean command */
export const cleanCommand = () =>
  Command.make(
    'clean',
    {},
    Effect.fn('mono.clean')(function* () {
      yield* ciGroup('Cleaning build artifacts')

      const skipArgs = CLEAN_SKIP.flatMap((dir) => ['--exclude', dir])

      for (const pattern of CLEAN_PATTERNS) {
        yield* runCommand({
          command: 'find',
          args: ['.', '-type', 'd', '-name', pattern.replace('**/', ''), ...skipArgs, '-prune'],
          shell: false,
        }).pipe(Effect.ignore)
      }

      yield* Console.log('  Removed dist folders and .tsbuildinfo files')
      yield* ciGroupEnd
      yield* Console.log('✓ Clean complete')
    }),
  ).pipe(Command.withDescription('Remove build artifacts (dist/, *.tsbuildinfo)'))
