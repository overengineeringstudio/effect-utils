/**
 * otel debug dashboards
 *
 * List and validate provisioned Grafana dashboards.
 */

import * as Cli from '@effect/cli'
import { Effect } from 'effect'

import { outputModeLayer, outputOption } from '@overeng/tui-react'

import { listDashboards, listDatasources } from '../../services/GrafanaClient.ts'

/** List and validate provisioned Grafana dashboards. */
export const dashboardsCommand = Cli.Command.make(
  'dashboards',
  {
    output: outputOption,
  },
  ({ output }) =>
    Effect.gen(function* () {
      // List dashboards
      const dashboards = yield* listDashboards()
      const datasources = yield* listDatasources()

      const tempoDs = datasources.find((ds) => ds.type === 'tempo')

      yield* Effect.log(`Dashboards (${String(dashboards.length)}):`)
      for (const db of dashboards) {
        yield* Effect.log(`  ${db.title} (uid: ${db.uid})`)
      }

      yield* Effect.log('')
      yield* Effect.log(`Datasources (${String(datasources.length)}):`)
      for (const ds of datasources) {
        yield* Effect.log(`  ${ds.name} (type: ${ds.type}, uid: ${ds.uid})`)
      }

      if (tempoDs !== undefined) {
        yield* Effect.log('')
        yield* Effect.log(`Tempo datasource: ${tempoDs.name} (uid: ${tempoDs.uid})`)
      } else {
        yield* Effect.log('')
        yield* Effect.log('WARNING: No Tempo datasource found')
      }
    }).pipe(Effect.provide(outputModeLayer(output))),
).pipe(Cli.Command.withDescription('List and validate provisioned Grafana dashboards'))
