/**
 * Megarepo CLI
 *
 * Main CLI entry point for the `mr` command.
 */

import * as Cli from '@effect/cli'
import { Option } from 'effect'

import { MR_VERSION } from '../lib/version.ts'
// Import extracted commands
import {
  addCommand,
  envCommand,
  execCommand,
  generateCommand,
  initCommand,
  lsCommand,
  pinCommand,
  unpinCommand,
  rootCommand,
  statusCommand,
  storeCommand,
  syncCommand,
} from './commands/mod.ts'

// Re-export context for use by other modules
export {
  Cwd,
  createSymlink,
  cwdOption,
  findMegarepoRoot,
  findNearestMegarepoRoot,
  outputOption,
  verboseOption,
} from './context.ts'

// Import Cwd and cwdOption for CLI assembly
import { Cwd, cwdOption } from './context.ts'

// =============================================================================
// Main CLI
// =============================================================================

/** Root CLI command */
export const mrCommand = Cli.Command.make('mr', { cwd: cwdOption }).pipe(
  Cli.Command.withSubcommands([
    initCommand,
    rootCommand,
    envCommand,
    statusCommand,
    lsCommand,
    syncCommand,
    addCommand,
    pinCommand,
    unpinCommand,
    execCommand,
    storeCommand,
    generateCommand,
  ]),
  Cli.Command.provide(({ cwd }) => (Option.isSome(cwd) ? Cwd.fromPath(cwd.value) : Cwd.live)),
  Cli.Command.withDescription('Multi-repo workspace management tool'),
)

/** Exported CLI for external use */
export const cli = Cli.Command.run(mrCommand, {
  name: 'mr',
  version: MR_VERSION,
})(process.argv)
