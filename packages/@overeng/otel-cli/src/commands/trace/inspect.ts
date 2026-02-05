/**
 * otel trace inspect [id] [--span-id S] [--flat]
 *
 * Inspect a trace as a span tree with waterfall timing bars.
 * Defaults to the most recent trace when no ID is provided.
 */

import * as Cli from '@effect/cli'
import { Effect } from 'effect'

import { outputOption, outputModeLayer } from '@overeng/tui-react'

/** Inspect a trace as a span tree with waterfall timing bars. */
export const inspectCommand = Cli.Command.make(
  'inspect',
  {
    output: outputOption,
    traceId: Cli.Args.optional(Cli.Args.text({ name: 'trace-id' })).pipe(
      Cli.Args.withDescription('Trace ID (full or prefix). Defaults to most recent trace.'),
    ),
    spanId: Cli.Options.optional(Cli.Options.text('span-id')).pipe(
      Cli.Options.withDescription('Focus on a specific span and its descendants'),
    ),
    flat: Cli.Options.boolean('flat').pipe(
      Cli.Options.withDescription('Show flat span list instead of tree'),
      Cli.Options.withDefault(false),
    ),
  },
  ({ output, traceId: _traceId, spanId: _spanId, flat: _flat }) =>
    Effect.gen(function* () {
      // TODO: Phase 3 implementation
      yield* Effect.log('otel trace inspect - not yet implemented')
    }).pipe(Effect.provide(outputModeLayer(output))),
).pipe(Cli.Command.withDescription('Inspect a trace as a span tree with waterfall timing bars'))
