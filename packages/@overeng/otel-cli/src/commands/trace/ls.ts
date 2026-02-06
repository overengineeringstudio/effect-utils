/**
 * otel trace ls [--query] [--limit] [--all]
 *
 * List recent traces from Tempo.
 */

import * as Cli from '@effect/cli'
import { Effect, Option } from 'effect'
import React from 'react'

import { outputModeLayer, outputOption } from '@overeng/tui-react/node'

import { LsApp, LsView } from '../../renderers/TraceLsOutput/mod.ts'
import { searchTraces } from '../../services/GrafanaClient.ts'

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
  ({ output, query: queryOption, limit, all }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const tui = yield* LsApp.run(React.createElement(LsView, { stateAtom: LsApp.stateAtom }))

        const queryValue = Option.getOrUndefined(queryOption)

        const traces = yield* Effect.catchAll(
          searchTraces({
            query: queryValue,
            limit,
            includeInternal: all,
          }),
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
          _tag: 'SetTraces',
          traces: traces.map((t) => ({
            traceId: t.traceId,
            serviceName: t.serviceName,
            spanName: t.spanName,
            durationMs: t.durationMs,
          })),
          query: queryValue,
          limit,
        })
      }),
    ).pipe(Effect.provide(outputModeLayer(output))),
).pipe(Cli.Command.withDescription('List recent traces'))
