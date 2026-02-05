/**
 * otel debug test
 *
 * End-to-end smoke test: send a span and verify it round-trips
 * through Collector -> Tempo -> Grafana.
 */

import * as Cli from '@effect/cli'
import { Effect } from 'effect'

import { outputOption, outputModeLayer } from '@overeng/tui-react'

/** End-to-end smoke test: send a span and verify round-trip through the OTEL stack. */
export const testCommand = Cli.Command.make(
  'test',
  {
    output: outputOption,
  },
  ({ output }) =>
    Effect.gen(function* () {
      // TODO: Phase 6 implementation
      yield* Effect.log('otel debug test - not yet implemented')
    }).pipe(Effect.provide(outputModeLayer(output))),
).pipe(Cli.Command.withDescription('End-to-end smoke test: send span and verify in Tempo'))
