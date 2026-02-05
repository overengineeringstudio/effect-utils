/**
 * otel trace ls [--query] [--limit] [--all]
 *
 * List recent traces from Tempo.
 */

import * as Cli from '@effect/cli'
import { Effect } from 'effect'

import { outputOption, outputModeLayer } from '@overeng/tui-react'

/** List recent traces from Tempo. */
export const lsCommand = Cli.Command.make(
  'ls',
  {
    output: outputOption,
    query: Cli.Options.optional(Cli.Options.text('query')).pipe(
      Cli.Options.withDescription('TraceQL query filter'),
    ),
    limit: Cli.Options.integer('limit').pipe(
      Cli.Options.withDescription('Maximum number of traces to return'),
      Cli.Options.withDefault(10),
    ),
    all: Cli.Options.boolean('all').pipe(
      Cli.Options.withDescription('Include internal Tempo traces'),
      Cli.Options.withDefault(false),
    ),
  },
  ({ output, query: _query, limit: _limit, all: _all }) =>
    Effect.gen(function* () {
      // TODO: Phase 4 implementation
      yield* Effect.log('otel trace ls - not yet implemented')
    }).pipe(Effect.provide(outputModeLayer(output))),
).pipe(Cli.Command.withDescription('List recent traces'))
