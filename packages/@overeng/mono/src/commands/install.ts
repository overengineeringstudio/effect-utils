import { Command, Options } from '@effect/cli'
import { Path } from '@effect/platform'
import { Console, Effect } from 'effect'

import type { CmdError } from '@overeng/utils/node'

import { InstallError } from '../errors.ts'
import type { InstallConfig } from '../tasks.ts'
import { cleanNodeModules, installAllWithTaskSystem } from '../tasks.ts'
import { ciGroup, ciGroupEnd, IS_CI } from '../utils.ts'

const cleanOption = Options.boolean('clean').pipe(
  Options.withAlias('c'),
  Options.withDescription('Remove node_modules before installing'),
  Options.withDefault(false),
)

/** Format error message from install failure */
const formatInstallError = (error: unknown): string => {
  if (typeof error === 'object' && error !== null) {
    // CmdError from @overeng/utils
    if ('_tag' in error && error._tag === 'CmdError' && 'command' in error && 'args' in error) {
      const cmd = error as CmdError
      return `Command failed: ${cmd.command} ${(cmd.args as string[]).join(' ')}`
    }
    // Generic error with message
    if ('message' in error) {
      return String(error.message)
    }
  }
  return String(error)
}

/** Create an install command */
export const installCommand = (config: InstallConfig) =>
  Command.make('install', { clean: cleanOption }, ({ clean }) =>
    Effect.gen(function* () {
      const pathService = yield* Path.Path
      const cwd = process.env.WORKSPACE_ROOT ?? process.cwd()

      if (clean) {
        yield* ciGroup('Cleaning node_modules')
        const count = yield* cleanNodeModules(config)
        yield* Console.log(`  Removed node_modules from ${count} packages`)
        yield* ciGroupEnd
      }

      const frozenLockfile = IS_CI
      if (frozenLockfile) {
        yield* Console.log('Using --frozen-lockfile (CI detected)\n')
      }

      // Use task system with inline renderer for live progress
      const { results, total } = yield* installAllWithTaskSystem({
        config,
        options: { frozenLockfile },
      })

      const successes = results.filter((r) => r._tag === 'success')
      const failures = results.filter((r) => r._tag === 'failure')

      // Show failures with full error output (task system already showed the summary)
      if (failures.length > 0) {
        yield* Console.log(`\n✗ Failed to install ${failures.length}/${total} packages:\n`)

        for (const result of failures) {
          const relativePath = pathService.relative(cwd, result.dir)
          yield* Console.log(`  ✗ ${relativePath}`)
          yield* Console.log(`    ${formatInstallError(result.error)}`)

          // Show stderr if available
          if (result.stderr && result.stderr.trim().length > 0) {
            yield* Console.log(
              `\n    stderr:\n${result.stderr
                .split('\n')
                .map((line) => `      ${line}`)
                .join('\n')}`,
            )
          }

          // Show stdout if available and different from stderr
          if (result.stdout && result.stdout.trim().length > 0 && result.stdout !== result.stderr) {
            yield* Console.log(
              `\n    stdout:\n${result.stdout
                .split('\n')
                .map((line) => `      ${line}`)
                .join('\n')}`,
            )
          }

          yield* Console.log('')
        }

        return yield* new InstallError({ failedCount: failures.length, totalCount: total })
      }

      yield* Console.log(`\n✓ Installed dependencies for ${successes.length} packages`)
    }),
  ).pipe(Command.withDescription('Install dependencies for all packages (bun install)'))
