import { Command } from '@effect/cli'
import type { FileSystem, Path, Terminal } from '@effect/platform'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import type * as CommandExecutor from '@effect/platform/CommandExecutor'
import { Cause, Effect, Layer, Logger, LogLevel } from 'effect'

import { CurrentWorkingDirectory } from '@overeng/utils/node'

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
  const command = Command.make(config.name).pipe(
    Command.withSubcommands(config.commands),
    Command.withDescription(config.description),
  )

  const cli = Command.run(command, {
    name: config.name,
    version: config.version,
  })

  const program = cli(process.argv).pipe(
    Effect.catchAllCause((cause) => {
      if (Cause.isInterruptedOnly(cause)) {
        return Effect.void
      }
      // Log the error, then re-fail so runMain exits with non-zero code
      return Effect.logError(cause).pipe(Effect.andThen(Effect.failCause(cause)))
    }),
    Effect.provide(
      Layer.mergeAll(
        NodeContext.layer,
        CurrentWorkingDirectory.live,
        Logger.minimumLogLevel(LogLevel.Debug),
      ),
    ),
  )

  NodeRuntime.runMain(program, { disableErrorReporting: true })
}
