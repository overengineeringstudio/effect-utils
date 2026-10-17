/**
 * Interaction spans: input event → first commit → next paint, for every discrete input (Event
 * Timing only reports slow ones). The span is live from the input's timestamp, so Effect work
 * started by the handler can run under it ({@link InteractionsShape.withActive}) and its HTTP/WS
 * calls carry the interaction's `traceparent` to the gateway.
 *
 * End time: the paint after the first commit when a commit was marked (React `<Profiler>`), else
 * the paint after the input itself (production React strips `<Profiler>`, and a discrete-event
 * update commits inside the dispatch, so that paint already contains it), else `settleMs`.
 */
import { Context, Effect, FiberSet, Layer, Metric, Option, Schema } from 'effect'
import type { Tracer } from 'effect'

import { OtelAttr, OtelMetric } from '@overeng/otel-contract'

import { BrowserPlatform, listenScoped } from '../BrowserPlatform.ts'
import { BrowserTelemetry } from '../BrowserTelemetry.ts'

/** Configuration for discrete input tracking and paint settlement. */
export interface InteractionsOptions {
  /** @default ['pointerdown', 'keydown'] — React Aria presses on pointerdown, `click` lands after the commit. */
  readonly events?: ReadonlyArray<string> | undefined
  /** @default 500 */
  readonly settleMs?: number | undefined
  /** Low-cardinality target label. @default closest `[data-perf-target]`, else `other`. */
  readonly target?: ((event: Event) => string) | undefined
}

/** Interaction context and commit hooks available to application handlers. */
export interface InteractionsShape {
  /** Marks a commit; pass as React `<Profiler onRender>`. */
  readonly markCommit: () => void
  /** The most recent interaction still waiting for its paint. */
  readonly active: () => Option.Option<Tracer.Span>
  /** Runs `effect` as a child of the active interaction (unchanged when there is none). */
  readonly withActive: <TValue, TError, TRequirements>(
    effect: Effect.Effect<TValue, TError, TRequirements>,
  ) => Effect.Effect<TValue, TError, TRequirements>
}

/** Scoped interaction tracking service. */
export class Interactions extends Context.Service<Interactions, InteractionsShape>()(
  '@overeng/otel-browser/Interactions',
) {}

/** Schema-first duration contract, preserving the exported histogram name and labels. */
export const durationContract = OtelMetric.histogram({
  name: 'browser_interaction_duration_seconds',
  description: 'Input event to next paint, per discrete interaction',
  unit: 's',
  boundaries: [0.016, 0.033, 0.05, 0.1, 0.2, 0.5, 1, 2],
  // `interaction.type` is one of the configured `events` (DOM event types), so it stays bounded.
  labels: Schema.Struct({
    type: OtelAttr.string({ key: 'interaction.type', metadata: { cardinality: 'bounded' } }),
  }),
})

/** Effect histogram for discrete input-to-paint durations. */
export const durationSeconds = OtelMetric.effect.histogram(durationContract).metric

interface Pending {
  readonly span: Tracer.Span
  readonly type: string
  readonly start: number
  commits: number
  commitAt: number | undefined
  commitPaintAt: number | undefined
  eventPaintAt: number | undefined
}

const defaultTarget = (event: Event) =>
  typeof Element !== 'undefined' && event.target instanceof Element
    ? (event.target.closest('[data-perf-target]')?.getAttribute('data-perf-target') ?? 'other')
    : 'other'

/** Typing-key repeats and lone modifiers are not interactions; Enter/Backspace/Escape are. */
const isDiscrete = (event: Event) => {
  if (!('key' in event) || typeof event.key !== 'string') return true
  const repeat = 'repeat' in event && event.repeat === true
  return (
    repeat === false &&
    (event.key.length === 1 || ['Enter', 'Backspace', 'Escape'].includes(event.key))
  )
}

const make = Effect.fnUntraced(function* (options?: InteractionsOptions) {
  const telemetry = yield* BrowserTelemetry
  const platform = yield* BrowserPlatform
  const settleMs = options?.settleMs ?? 500
  const targetOf = options?.target ?? defaultTarget
  const pending: Pending[] = []
  const runFork = yield* FiberSet.makeRuntime<never>()

  const finish = (interaction: Pending) => {
    const index = pending.indexOf(interaction)
    if (index === -1) return
    pending.splice(index, 1)
    const endMs =
      interaction.commitPaintAt ?? interaction.eventPaintAt ?? interaction.start + settleMs
    const span = interaction.span
    span.attribute('browser.interaction.commits', interaction.commits)
    span.attribute('browser.interaction.paint_ms', endMs - interaction.start)
    if (interaction.commitAt !== undefined) {
      span.attribute('browser.interaction.commit_ms', interaction.commitAt - interaction.start)
    }
    telemetry.endSpan({ span, endMs })
    telemetry.updateMetric({
      metric: Metric.withAttributes(
        durationSeconds,
        Object.entries(durationContract.encodeLabelsSync({ type: interaction.type })).map(
          ([key, value]): [string, string] => [key, String(value)],
        ),
      ),
      input: (endMs - interaction.start) / 1000,
    })
  }

  const onInput = (event: Event) => {
    if (isDiscrete(event) === false) return
    const target = targetOf(event)
    const interaction: Pending = {
      span: telemetry.startSpan({
        name: 'browser.interaction',
        startMs: event.timeStamp,
        attributes: {
          'span.label': `${event.type} ${target}`,
          'browser.interaction.type': event.type,
          'browser.interaction.target': target,
        },
      }),
      type: event.type,
      start: event.timeStamp,
      commits: 0,
      commitAt: undefined,
      commitPaintAt: undefined,
      eventPaintAt: undefined,
    }
    pending.push(interaction)
    platform.afterNextPaint(() => {
      interaction.eventPaintAt = platform.now()
    })
    runFork(Effect.sleep(settleMs).pipe(Effect.andThen(Effect.sync(() => finish(interaction)))))
  }

  for (const type of options?.events ?? ['pointerdown', 'keydown']) {
    yield* listenScoped({ target: 'window', type, handler: onInput, options: { capture: true } })
  }
  // Teardown ends open interactions now so they make the final flush instead of vanishing.
  yield* Effect.addFinalizer(() => Effect.sync(() => pending.slice().forEach(finish)))

  const active = () => Option.fromUndefinedOr(pending.at(-1)?.span)
  const service: InteractionsShape = {
    markCommit: () => {
      const now = platform.now()
      for (const interaction of pending) {
        interaction.commits += 1
        if (interaction.commitAt !== undefined) continue
        interaction.commitAt = now
        platform.afterNextPaint(() => {
          interaction.commitPaintAt = platform.now()
        })
      }
    },
    active,
    withActive: (effect) =>
      Effect.suspend(() => {
        const span = active()
        return Option.isSome(span) === true ? Effect.withParentSpan(effect, span.value) : effect
      }),
  }
  return service
})

/** Builds scoped input listeners and tracks interaction spans until their next paint. */
export const layer = (
  options?: InteractionsOptions,
): Layer.Layer<Interactions, never, BrowserTelemetry | BrowserPlatform> =>
  Layer.effect(Interactions, make(options))
