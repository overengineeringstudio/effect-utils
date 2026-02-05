/**
 * otel health
 *
 * Check the health of the OTEL observability stack.
 */

import * as Cli from '@effect/cli'
import { Effect } from 'effect'

import { outputOption, outputModeLayer } from '@overeng/tui-react'

/** Check OTEL stack health (Grafana, Tempo, Collector). */
export const healthCommand = Cli.Command.make(
  'health',
  {
    output: outputOption,
  },
  ({ output }) =>
    Effect.gen(function* () {
      // TODO: Phase 5 implementation
      yield* Effect.log('otel health - not yet implemented')
    }).pipe(Effect.provide(outputModeLayer(output))),
).pipe(Cli.Command.withDescription('Check OTEL stack health (Grafana, Tempo, Collector)'))
