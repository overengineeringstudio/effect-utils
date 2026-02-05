/**
 * otel health
 *
 * Check the health of the OTEL observability stack.
 */

import * as Cli from '@effect/cli'
import { Effect } from 'effect'
import React from 'react'

import { outputModeLayer, outputOption } from '@overeng/tui-react'

import { HealthApp, HealthView, type ComponentHealth } from '../renderers/HealthOutput/mod.ts'
import { checkHealth as checkCollectorHealth } from '../services/CollectorClient.ts'
import { checkHealth as checkGrafanaHealth } from '../services/GrafanaClient.ts'
import { checkReady as checkTempoReady } from '../services/TempoClient.ts'

/** Check OTEL stack health (Grafana, Tempo, Collector). */
export const healthCommand = Cli.Command.make(
  'health',
  {
    output: outputOption,
  },
  ({ output }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const tui = yield* HealthApp.run(
          React.createElement(HealthView, { stateAtom: HealthApp.stateAtom }),
        )

        const components: Array<ComponentHealth> = []

        // Check Grafana
        const grafanaResult = yield* Effect.either(checkGrafanaHealth())
        if (grafanaResult._tag === 'Right') {
          components.push({
            name: 'Grafana',
            healthy: true,
            version: grafanaResult.right.version,
            message: `database: ${grafanaResult.right.database}`,
          })
        } else {
          components.push({
            name: 'Grafana',
            healthy: false,
            message: grafanaResult.left.message,
          })
        }

        // Check Tempo
        const tempoResult = yield* Effect.either(checkTempoReady())
        if (tempoResult._tag === 'Right') {
          components.push({
            name: 'Tempo',
            healthy: tempoResult.right,
            message: tempoResult.right ? 'ready' : 'not ready',
          })
        } else {
          components.push({
            name: 'Tempo',
            healthy: false,
            message: tempoResult.left.message,
          })
        }

        // Check Collector
        const collectorResult = yield* Effect.either(checkCollectorHealth())
        if (collectorResult._tag === 'Right') {
          components.push({
            name: 'Collector',
            healthy: collectorResult.right,
            message: collectorResult.right
              ? 'metrics endpoint responding'
              : 'metrics endpoint not responding',
          })
        } else {
          components.push({
            name: 'Collector',
            healthy: false,
            message: collectorResult.left.message,
          })
        }

        const allHealthy = components.every((c) => c.healthy)

        tui.dispatch({
          _tag: 'SetHealth',
          components,
          allHealthy,
        })
      }),
    ).pipe(Effect.provide(outputModeLayer(output))),
).pipe(Cli.Command.withDescription('Check OTEL stack health (Grafana, Tempo, Collector)'))
