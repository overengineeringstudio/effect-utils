/**
 * Debug subcommands
 *
 * Groups diagnostic/debugging commands: test and dashboards.
 */

import * as Cli from '@effect/cli'

import { dashboardsCommand } from './dashboards.ts'
import { testCommand } from './test.ts'

/** Debug subcommand grouping diagnostic tools. */
export const debugCommand = Cli.Command.make('debug').pipe(
  Cli.Command.withSubcommands([testCommand, dashboardsCommand]),
  Cli.Command.withDescription('Debug and diagnostic tools'),
)
