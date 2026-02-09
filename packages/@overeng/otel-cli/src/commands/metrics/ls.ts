/**
 * otel metrics ls [--filter] [--source]
 *
 * List metrics from the OTEL Collector or Tempo tags.
 */

import * as Cli from '@effect/cli'
import { Effect, Option } from 'effect'
import React from 'react'

import { outputModeLayer, outputOption } from '@overeng/tui-react/node'

import { LsApp, LsView, type MetricSummary } from '../../renderers/MetricsLsOutput/mod.ts'
import { getCollectorMetrics, getTags, getTagValues } from '../../services/MetricsClient.ts'

/** List metrics from collector or tempo. */
export const lsCommand = Cli.Command.make(
  'ls',
  {
    output: outputOption,
    filter: Cli.Options.optional(Cli.Options.text('filter')).pipe(
      Cli.Options.withDescription('Filter metrics by name pattern'),
    ),
    source: Cli.Options.choice('source', ['collector', 'tempo']).pipe(
      Cli.Options.withDescription('Metrics source: collector (Prometheus) or tempo (tags)'),
      Cli.Options.withDefault('collector' as const),
    ),
  },
  ({ output, filter: filterOption, source }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const tui = yield* LsApp.run(React.createElement(LsView, { stateAtom: LsApp.stateAtom }))
        const filterValue = Option.getOrUndefined(filterOption)

        if (source === 'collector') {
          // Get collector metrics (Prometheus format)
          const result = yield* Effect.catchAll(getCollectorMetrics(), (error) =>
            Effect.gen(function* () {
              tui.dispatch({
                _tag: 'SetError',
                error: error.reason,
                message: error.message,
              })
              return yield* error
            }),
          )

          // Filter and transform metrics
          let metrics = result.metrics.map(
            (m): MetricSummary => ({
              name: m.name,
              type: m.type,
              value: m.value,
              labels: m.labels,
              help: m.help,
            }),
          )

          if (filterValue) {
            const pattern = filterValue.toLowerCase()
            metrics = metrics.filter((m) => m.name.toLowerCase().includes(pattern))
          }

          // Dedupe by name+labels (keep first)
          const seen = new Set<string>()
          metrics = metrics.filter((m) => {
            const key = `${m.name}:${JSON.stringify(m.labels)}`
            if (seen.has(key)) return false
            seen.add(key)
            return true
          })

          tui.dispatch({
            _tag: 'SetMetrics',
            metrics,
            metricNames: result.metricNames,
            filter: filterValue,
            source: 'collector',
          })
        } else {
          // Get tempo tags as metrics
          const tags = yield* Effect.catchAll(getTags(), (error) =>
            Effect.gen(function* () {
              tui.dispatch({
                _tag: 'SetError',
                error: error.reason,
                message: error.message,
              })
              return yield* error
            }),
          )

          // Filter tags
          let filteredTags = tags
          if (filterValue) {
            const pattern = filterValue.toLowerCase()
            filteredTags = tags.filter((t) => t.toLowerCase().includes(pattern))
          }

          // Get value counts for each tag (limited to first 10 for performance)
          const metrics: MetricSummary[] = []
          for (const tag of filteredTags.slice(0, 50)) {
            const values = yield* Effect.catchAll(getTagValues(tag), () =>
              Effect.succeed([] as readonly string[]),
            )
            metrics.push({
              name: tag,
              type: 'tag',
              value: values.length,
              labels: {},
              help: `${String(values.length)} unique values`,
            })
          }

          tui.dispatch({
            _tag: 'SetMetrics',
            metrics,
            metricNames: filteredTags,
            filter: filterValue,
            source: 'tempo',
          })
        }
      }),
    ).pipe(Effect.provide(outputModeLayer(output))),
).pipe(Cli.Command.withDescription('List available metrics'))
