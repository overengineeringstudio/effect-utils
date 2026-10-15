import { Effect, type Scope } from 'effect'

import type { Series } from '../../series/index.ts'
import { makeSource, type Source, type SourceError } from '../../session/index.ts'

/** Content-free completion evidence; no names, attributes, IDs, or payloads. */
export interface SpanCompletion {
  readonly atMs: number
  readonly durationMs: number
  readonly status: 'Success' | 'Error'
}
/** Exact completion events, independent of retained history or export sampling. */
export interface SpanCompletionFeed {
  readonly subscribe: (options: {
    readonly onComplete: (value: SpanCompletion) => void
  }) => Effect.Effect<void, SourceError, Scope.Scope>
}
/** Per-completion duration/status and exact lifetime totals; rate is their delta over observation time. */
export interface SpanSummary {
  readonly _tag: 'SpanSummary'
  readonly durationMs: number
  readonly status: 'Success' | 'Error'
  readonly completions: number
  readonly errors: number
}
/** An explicit host sink; its feed installs hooks only inside the meters lease. */
export interface SpanCompletionSink {
  readonly feed: SpanCompletionFeed
  readonly complete: (value: SpanCompletion) => void
}
/** Create an inert sink for a host-installed tracer or explicit instrumentation. */
export const makeSpanCompletionSink = (): SpanCompletionSink => {
  const listeners = new Set<(value: SpanCompletion) => void>()
  return {
    complete: (value) => {
      if (Number.isFinite(value.durationMs) === false || value.durationMs < 0)
        throw new TypeError('Span duration must be finite and nonnegative')
      if (Number.isFinite(value.atMs) === false)
        throw new TypeError('Span completion timestamp must be finite')
      const completion: SpanCompletion = Object.freeze({
        atMs: value.atMs,
        durationMs: value.durationMs,
        status: value.status,
      })
      let listenerFailure: unknown
      let failed = false
      for (const listener of listeners) {
        try {
          listener(completion)
        } catch (cause) {
          if (failed === false) listenerFailure = cause
          failed = true
        }
      }
      if (failed === true) throw listenerFailure
    },
    feed: {
      subscribe: ({ onComplete }) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            listeners.add(onComplete)
          }),
          () =>
            Effect.sync(() => {
              listeners.delete(onComplete)
            }),
        ).pipe(Effect.asVoid),
    },
  }
}

/** Aggregate completions without retaining any span content or installing a tracer. */
export const spansSource = (options: {
  readonly id: string
  readonly series: Series<SpanSummary>
  readonly feed?: SpanCompletionFeed
}): Source<SpanSummary> => {
  let completions = 0
  let errors = 0
  return makeSource({
    id: options.id,
    series: options.series,
    cadence: { _tag: 'Event' },
    evidence: {
      counters: () => ({
        [`${options.id}.completions`]: completions,
        [`${options.id}.errors`]: errors,
      }),
    },
    start: ({ sink, clock }) => {
      const feed = options.feed
      if (feed === undefined)
        return Effect.sync(() =>
          sink.append({
            sample: { _tag: 'Unavailable', atMs: clock.now(), reason: 'NotConfigured' },
          }),
        )
      return feed.subscribe({
        onComplete: (completion) => {
          completions++
          if (completion.status === 'Error') errors++
          sink.append({
            sample: {
              _tag: 'Value',
              atMs: clock.now(),
              value: {
                _tag: 'SpanSummary',
                durationMs: completion.durationMs,
                status: completion.status,
                completions,
                errors,
              },
            },
          })
        },
      })
    },
  })
}
