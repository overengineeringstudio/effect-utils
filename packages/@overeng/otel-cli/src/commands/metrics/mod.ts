/**
 * Metrics subcommands
 *
 * Groups metrics-related commands: ls, query, tags.
 */

import * as Cli from '@effect/cli'

import { lsCommand } from './ls.ts'
import { queryCommand } from './query.ts'
import { tagsCommand } from './tags.ts'

/** Metrics subcommand grouping ls, query, and tags. */
export const metricsCommand = Cli.Command.make('metrics').pipe(
  Cli.Command.withSubcommands([lsCommand, queryCommand, tagsCommand]),
  Cli.Command.withDescription('TraceQL metrics queries and collector stats'),
)
