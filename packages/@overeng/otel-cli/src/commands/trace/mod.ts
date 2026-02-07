/**
 * Trace subcommands
 *
 * Groups trace-related commands: inspect and ls.
 */

import * as Cli from '@effect/cli'

import { inspectCommand } from './inspect.ts'
import { lsCommand } from './ls.ts'

/** Trace subcommand grouping inspect and ls. */
export const traceCommand = Cli.Command.make('trace').pipe(
  Cli.Command.withSubcommands([inspectCommand, lsCommand]),
  Cli.Command.withDescription('Trace inspection and listing'),
)
