/**
 * otel debug dashboards
 *
 * List and validate provisioned Grafana dashboards.
 */

import * as Cli from '@effect/cli'
import { Effect } from 'effect'

import { outputOption, outputModeLayer } from '@overeng/tui-react'

/** List and validate provisioned Grafana dashboards. */
export const dashboardsCommand = Cli.Command.make(
  'dashboards',
  {
    output: outputOption,
  },
  ({ output }) =>
    Effect.gen(function* () {
      // TODO: Phase 6 implementation
      yield* Effect.log('otel debug dashboards - not yet implemented')
    }).pipe(Effect.provide(outputModeLayer(output))),
).pipe(Cli.Command.withDescription('List and validate provisioned Grafana dashboards'))
