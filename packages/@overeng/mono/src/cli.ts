import { Command } from '@effect/cli'
import type { FileSystem, Path, Terminal } from '@effect/platform'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import type * as CommandExecutor from '@effect/platform/CommandExecutor'
import { Cause, Chunk, Console, Effect, Exit, Layer, Logger, LogLevel } from 'effect'

import { CurrentWorkingDirectory } from '@overeng/utils/node'

import { CommandError, GenieCoverageError } from './errors.ts'

// =============================================================================
// Types
// =============================================================================

/** Configuration for creating a mono CLI */
export interface MonoCliConfig {
  /** CLI name (used in help text and shell completion) */
  name: string
  /** CLI version */
  version: string
  /** CLI description */
  description: string
}

/** Services provided by the standard mono CLI layer */
export type StandardMonoContext =
  | CommandExecutor.CommandExecutor
  | CurrentWorkingDirectory
  | FileSystem.FileSystem
  | Path.Path
  | Terminal.Terminal

const shouldSuggestLintFix = (args: readonly string[]): boolean => {
  const argSet = new Set(args)
  return argSet.has('lint') && !argSet.has('--fix')
}



// =============================================================================
// CLI Runner
// =============================================================================

/**
 * Run a Mono CLI with standard Effect platform layers.
 *
 * Provides the standard layers:
 * - NodeContext.layer (FileSystem, CommandExecutor, etc.)
 * - CurrentWorkingDirectory.live
 * - Logger at Debug level
 *
 * @example
 * ```ts
 * runMonoCli({
 *   name: 'mono',
 *   version: '0.1.0',
 *   description: 'Monorepo management CLI',
 *   commands: [
 *     buildCommand(),
 *     testCommand(),
 *     lintCommand(config),
 *   ],
 * })
 * ```
 */
export const runMonoCli = <const TCmds extends readonly [Command.Command<any, any, any, any>, ...Command.Command<any, any, any, any>[]]>(
  config: MonoCliConfig & {
    commands: TCmds
  },
): void => {
   const shouldShowLintFixHint = shouldSuggestLintFix(process.argv.slice(2))

  const renderFailure = (failure: unknown): string => {
    if (failure instanceof CommandError) {
      const details = failure.message.trim()
      const showDetails = details.length > 0 && !(details.startsWith('{') && details.endsWith('}'))

      if (showDetails) {
        return `Command failed: ${failure.command}\n  ${details}`
      }
      return `Command failed: ${failure.command}`
    }

    if (failure instanceof GenieCoverageError) {
      return failure.message
    }

    if (failure instanceof Error) {
      return failure.message.length > 0 ? failure.message : String(failure)
    }

    return String(failure)
  }

  const reportFailure = Effect.fn('reportFailure')(function* (cause: Cause.Cause<unknown>) {
    if (Cause.isInterruptedOnly(cause)) {
      return
    }

    const failures = Chunk.toReadonlyArray(Cause.failures(cause))
    if (failures.length > 0) {
      const message = failures.map(renderFailure).join('\n\n')
      yield* Console.error(message)
    } else {
      yield* Console.error(Cause.pretty(cause, { renderErrorCause: true }))
    }

    if (shouldShowLintFixHint) {
      yield* Console.error("Hint: run 'mono lint --fix' to auto-fix formatting and lint issues.")
    }

    yield* Effect.sync(() => {
      process.exitCode = 1
    })
  })

  const command = Command.make(config.name).pipe(
    Command.withSubcommands(config.commands),
    Command.withDescription(config.description),
  )

  const cli = Command.run(command, {
    name: config.name,
    version: config.version,
  })

  const program = cli(process.argv).pipe(
    Effect.scoped, // Provide Scope for entire CLI execution
    Effect.exit,
    Effect.flatMap(
      Exit.matchEffect({
        onFailure: reportFailure,
        onSuccess: () => Effect.void,
      }),
    ),
    Effect.provide(
      Layer.mergeAll(
        NodeContext.layer,
        CurrentWorkingDirectory.live,
        Logger.minimumLogLevel(LogLevel.Debug),
      ),
    ),
    Effect.asVoid,
  ) as Effect.Effect<void>

  NodeRuntime.runMain(program, { disableErrorReporting: true })
}
