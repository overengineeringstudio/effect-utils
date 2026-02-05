/**
 * otel trace inspect [id] [--span-id S] [--flat]
 *
 * Inspect a trace as a span tree with waterfall timing bars.
 * Defaults to the most recent trace when no ID is provided.
 */

import * as Cli from '@effect/cli'
import type { HttpClient } from '@effect/platform'
import { Effect, Option } from 'effect'
import React from 'react'

import { outputModeLayer, outputOption } from '@overeng/tui-react'

import { buildSpanTree } from '../../lib/span-tree.ts'
import { InspectApp, InspectView } from '../../renderers/TraceInspectOutput/mod.ts'
import { type GrafanaError, searchTraces } from '../../services/GrafanaClient.ts'
import type { OtelConfig } from '../../services/OtelConfig.ts'
import { getTrace } from '../../services/TempoClient.ts'

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
  ({ output, traceId: traceIdOption, spanId: spanIdOption, flat }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const tui = yield* InspectApp.run(
          React.createElement(InspectView, { stateAtom: InspectApp.stateAtom }),
        )

        // Resolve trace ID: use provided or fetch most recent
        const resolvedTraceId = yield* resolveTraceId(traceIdOption)

        if (resolvedTraceId === undefined) {
          tui.dispatch({
            _tag: 'SetError',
            error: 'No traces found',
            message:
              'No traces found in Tempo. Make sure the OTEL stack is running and spans are being sent.',
          })
          return
        }

        // Fetch the full trace
        const traceResponse = yield* Effect.catchAll(getTrace(resolvedTraceId), (error) =>
          Effect.gen(function* () {
            tui.dispatch({
              _tag: 'SetError',
              error: error.reason,
              message: error.message,
            })
            return yield* Effect.fail(error)
          }),
        )

        // Build span tree
        const spanIdValue = Option.getOrUndefined(spanIdOption)
        const tree = buildSpanTree({
          response: traceResponse,
          spanId: spanIdValue,
        })

        tui.dispatch({
          _tag: 'SetTrace',
          traceId: resolvedTraceId,
          rootSpans: [...tree.rootSpans],
          totalSpanCount: tree.totalSpanCount,
          traceStartMs: tree.traceStartMs,
          traceEndMs: tree.traceEndMs,
          traceDurationMs: tree.traceDurationMs,
          flat,
        })
      }),
    ).pipe(Effect.provide(outputModeLayer(output))),
).pipe(Cli.Command.withDescription('Inspect a trace as a span tree with waterfall timing bars'))

// =============================================================================
// Internal
// =============================================================================

/** Resolve trace ID from an optional argument, falling back to the most recent trace. */
const resolveTraceId = (
  traceIdOption: Option.Option<string>,
): Effect.Effect<string | undefined, GrafanaError, OtelConfig | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const explicit = Option.getOrUndefined(traceIdOption)
    if (explicit !== undefined) return explicit

    // Fetch most recent trace
    const traces = yield* searchTraces({ limit: 1 })
    return traces[0]?.traceId
  })
