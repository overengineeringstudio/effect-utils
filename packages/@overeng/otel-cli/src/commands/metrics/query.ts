/**
 * otel metrics query <query> [--start] [--end] [--step]
 *
 * Execute a TraceQL metrics query against Tempo.
 */

import * as Cli from '@effect/cli'
import { Effect, Option } from 'effect'
import React from 'react'

import { outputModeLayer, outputOption } from '@overeng/tui-react/node'

import { QueryApp, QueryView } from '../../renderers/MetricsQueryOutput/mod.ts'
import { queryMetrics } from '../../services/MetricsClient.ts'

/** Execute a TraceQL metrics query. */
export const queryCommand = Cli.Command.make(
  'query',
  {
    output: outputOption,
    query: Cli.Args.text({ name: 'query' }).pipe(
      Cli.Args.withDescription(
        'TraceQL metrics query (e.g., "{} | rate()" or "{service.name=\\"dt\\"} | histogram_over_time(duration)")',
      ),
    ),
    start: Cli.Options.optional(Cli.Options.integer('start')).pipe(
      Cli.Options.withDescription('Start time (Unix timestamp in seconds, default: 1 hour ago)'),
    ),
    end: Cli.Options.optional(Cli.Options.integer('end')).pipe(
      Cli.Options.withDescription('End time (Unix timestamp in seconds, default: now)'),
    ),
    step: Cli.Options.integer('step').pipe(
      Cli.Options.withDescription('Query step in seconds'),
      Cli.Options.withDefault(60),
    ),
    range: Cli.Options.choice('range', ['1h', '6h', '24h', '7d']).pipe(
      Cli.Options.withDescription('Time range preset (overrides --start)'),
      Cli.Options.withDefault('1h' as const),
    ),
  },
  ({ output, query, start: startOption, end: endOption, step, range }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const tui = yield* QueryApp.run(
          React.createElement(QueryView, { stateAtom: QueryApp.stateAtom }),
        )

        const now = Math.floor(Date.now() / 1000)
        const endTime = Option.getOrElse(endOption, () => now)

        // Calculate start time from range or explicit option
        const rangeSeconds: Record<string, number> = {
          '1h': 3600,
          '6h': 6 * 3600,
          '24h': 24 * 3600,
          '7d': 7 * 24 * 3600,
        }
        const defaultStart = endTime - (rangeSeconds[range] ?? 3600)
        const startTime = Option.getOrElse(startOption, () => defaultStart)

        const result = yield* Effect.catchAll(
          queryMetrics({ query, start: startTime, end: endTime, step }),
          (error) =>
            Effect.gen(function* () {
              tui.dispatch({
                _tag: 'SetError',
                error: error.reason,
                message: error.message,
              })
              return yield* error
            }),
        )

        tui.dispatch({
          _tag: 'SetResults',
          series: result.map((s) => ({
            name: s.name,
            labels: s.labels,
            samples: s.samples.map((p) => ({
              timestampMs: p.timestampMs,
              value: p.value,
            })),
            exemplarCount: s.exemplarCount,
          })),
          query,
          startTime,
          endTime,
          step,
        })
      }),
    ).pipe(Effect.provide(outputModeLayer(output))),
).pipe(Cli.Command.withDescription('Execute a TraceQL metrics query'))
