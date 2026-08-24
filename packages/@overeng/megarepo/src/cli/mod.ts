/**
 * Megarepo CLI
 *
 * Main CLI entry point for the `mr` command.
 */

import * as Cli from 'effect/unstable/cli'
import { Option } from 'effect'

import { rewriteHelpSubcommand } from '@overeng/utils/node/cli-help-rewrite'

import { MR_VERSION } from '../lib/version.ts'
// Import extracted commands
import {
  addCommand,
  applyCommand,
  checkCommand,
  configCommand,
  depsCommand,
  envCommand,
  execCommand,
  fetchCommand,
  generateCommand,
  initCommand,
  lockCommand,
  lsCommand,
  rootCommand,
  statusCommand,
  storeCommand,
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
    checkCommand,
    fetchCommand,
    applyCommand,
    lockCommand,
    addCommand,
    configCommand,
    execCommand,
    storeCommand,
    generateCommand,
    depsCommand,
  ]),
  Cli.Command.provide((config) =>
    'cwd' in config && Option.isSome(config.cwd) === true
      ? Cwd.fromPath(config.cwd.value)
      : Cwd.live,
  ),
  Cli.Command.withDescription('Multi-repo workspace management tool'),
)

/** Exported CLI for external use */
export const cli = Cli.Command.runWith(mrCommand, { version: MR_VERSION })(rewriteHelpSubcommand(process.argv))
