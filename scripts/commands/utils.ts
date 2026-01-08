import type * as CommandExecutor from '@effect/platform/CommandExecutor'
import type { PlatformError } from '@effect/platform/Error'
import type { Scope } from 'effect'
import { Console, Effect } from 'effect'

import { CurrentWorkingDirectory, cmd, cmdStart } from '@overeng/utils/node'

import { CommandError } from './errors.js'

export const IS_CI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true'

const formatCommandErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export const runCommand = (options: {
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string | undefined>
  shell?: boolean
}): Effect.Effect<void, CommandError, CommandExecutor.CommandExecutor | CurrentWorkingDirectory> =>
  Effect.gen(function* () {
    const defaultCwd = process.env.WORKSPACE_ROOT ?? (yield* CurrentWorkingDirectory)
    const cwd = options.cwd ?? defaultCwd
    const useShell = options.shell ?? true
    const cmdOptions = {
      shell: useShell,
      ...(options.env ? { env: options.env } : {}),
    }

    return yield* cmd([options.command, ...options.args], cmdOptions).pipe(
      Effect.provideService(CurrentWorkingDirectory, cwd),
      Effect.asVoid,
      Effect.catchAll((error) =>
        Effect.fail(
          new CommandError({
            command: `${options.command} ${options.args.join(' ')}`,
            message: formatCommandErrorMessage(error),
          }),
        ),
      ),
    )
  })

export const startProcess = (options: {
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string | undefined>
  shell?: boolean
}): Effect.Effect<
  CommandExecutor.Process,
  PlatformError,
  CommandExecutor.CommandExecutor | CurrentWorkingDirectory | Scope.Scope
> =>
  Effect.gen(function* () {
    const defaultCwd = process.env.WORKSPACE_ROOT ?? (yield* CurrentWorkingDirectory)
    const cwd = options.cwd ?? defaultCwd
    const useShell = options.shell ?? false
    const cmdOptions = {
      shell: useShell,
      ...(options.env ? { env: options.env } : {}),
    }

    return yield* cmdStart([options.command, ...options.args], cmdOptions).pipe(
      Effect.provideService(CurrentWorkingDirectory, cwd),
    )
  })

export const ciGroup = (name: string) =>
  IS_CI ? Console.log(`::group::${name}`) : Console.log(`\n▶ ${name}`)

export const ciGroupEnd = IS_CI ? Console.log('::endgroup::') : Effect.void
