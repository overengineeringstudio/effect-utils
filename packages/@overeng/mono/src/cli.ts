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

/**
 * Command type for mono CLI subcommands.
 *
 * Uses `any` for the Name and Value type parameters due to TypeScript's invariance
 * on Command's type parameters (via Context<Name> and handler contravariance).
 * This is the same approach used by @effect/cli's withSubcommands.
 * The R and E type parameters use proper types to ensure commands can be
 * provided with the standard mono context and produce typed errors.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MonoCommand = Command.Command<any, StandardMonoContext, Error, any>

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
export const runMonoCli = (
  config: MonoCliConfig & {
    commands: readonly [MonoCommand, ...MonoCommand[]]
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

  const reportFailure = (cause: Cause.Cause<unknown>) =>
    Effect.gen(function* () {
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
  ) as Effect.Effect<void, unknown, never>

  NodeRuntime.runMain(program, { disableErrorReporting: true })
}
