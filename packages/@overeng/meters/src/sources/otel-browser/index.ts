import { Effect } from 'effect'

import type { Series } from '../../series/index.ts'
import type { Source } from '../../session/index.ts'
import { spansSource, type SpanSummary } from '../spans/index.ts'

/** Structural host-ring seam; no telemetry package types or retained span content are required. */
export interface OtelBrowserSpanRing {
  readonly subscribeCompletions: (options: {
    readonly onComplete: (completion: {
      readonly atMs: number
      readonly durationMs: number
      readonly status: 'ok' | 'error' | 'interrupted'
    }) => void
  }) => () => void
}

/** Observe exact host-ring completions without creating telemetry, replaying history, or wrapping a tracer. */
export const otelBrowserSpansSource = (options: {
  readonly id: string
  readonly series: Series<SpanSummary>
  readonly ring?: OtelBrowserSpanRing
}): Source<SpanSummary> => {
  const ring = options.ring
  return spansSource({
    id: options.id,
    series: options.series,
    ...(ring === undefined
      ? {}
      : {
          feed: {
            subscribe: ({ onComplete }) =>
              Effect.acquireRelease(
                Effect.sync(() =>
                  ring.subscribeCompletions({
                    onComplete: (completion) =>
                      onComplete({
                        atMs: completion.atMs,
                        durationMs: completion.durationMs,
                        status: completion.status === 'ok' ? 'Success' : 'Error',
                      }),
                  }),
                ),
                (unsubscribe) => Effect.sync(unsubscribe),
              ).pipe(Effect.asVoid),
          },
        }),
  })
}
