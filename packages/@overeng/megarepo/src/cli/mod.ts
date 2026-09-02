/**
 * Megarepo CLI
 *
 * Main CLI entry point for the `mr` command.
 */

import * as Cli from 'effect/unstable/cli'

import { rewriteHelpSubcommand } from '@overeng/utils/node/cli-help-rewrite'

import { MR_VERSION } from '../core/version.ts'
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
  CwdFromGlobalFlag,
  createSymlink,
  cwdGlobalFlag,
  findMegarepoRoot,
  findNearestMegarepoRoot,
  outputOption,
  verboseOption,
} from './context.ts'

// Import Cwd wiring for CLI assembly
import { CwdFromGlobalFlag, cwdGlobalFlag } from './context.ts'

// =============================================================================
// Main CLI
// =============================================================================

/** Root CLI command */
export const mrCommand = Cli.Command.make('mr').pipe(
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
  Cli.Command.withGlobalFlags([cwdGlobalFlag]),
  Cli.Command.provide(CwdFromGlobalFlag),
  Cli.Command.withDescription('Multi-repo workspace management tool'),
)

/** Exported CLI for external use */
export const cli = (args: ReadonlyArray<string>) =>
  Cli.Command.runWith(mrCommand, { version: MR_VERSION })(rewriteHelpSubcommand(args))
