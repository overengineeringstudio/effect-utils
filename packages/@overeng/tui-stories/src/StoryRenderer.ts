/**
 * Render a captured story to output.
 *
 * Supports all output modes matching the web Storybook tabs:
 * - tty/alt-screen/ci/ci-plain/log: React rendering with different RenderConfigs
 * - json: Final state encoded via Schema
 * - ndjson: Timeline events as newline-delimited JSON
 */

import { Effect, Schema } from 'effect'
import { Atom, AtomRegistry } from 'effect/unstable/reactivity'

import type { TimelineEvent } from '@overeng/tui-react/storybook'

import { loadStoryRuntime, type CapturedStoryProps } from './StoryCapture.ts'

// =============================================================================
// Types
// =============================================================================

/** How to apply the timeline for state computation */
export type TimelineMode = 'initial' | 'final' | { readonly at: number }

/**
 * Output mode — mirrors the web Storybook tabs exactly.
 *
 * React modes (rendered via renderToString with different RenderConfigs):
 * - tty: animated spinners, colors, unicode
 * - alt-screen: same as tty but with alternate buffer flag
 * - ci: static spinners, colors, unicode
 * - ci-plain: static spinners, no colors, unicode
 * - log: static spinners, no colors (final timing)
 *
 * Data modes (state serialized as JSON):
 * - json: final state encoded via stateSchema
 * - ndjson: each timeline step encoded as a JSON line
 */
export type OutputMode = 'tty' | 'alt-screen' | 'ci' | 'ci-plain' | 'log' | 'json' | 'ndjson'

/** All valid output mode values */
export const OUTPUT_MODES = [
  'tty',
  'alt-screen',
  'ci',
  'ci-plain',
  'log',
  'json',
  'ndjson',
] as const

/** Options for rendering a story */
export interface RenderStoryOptions {
  readonly captured: CapturedStoryProps
  readonly width: number
  readonly timelineMode: TimelineMode
  readonly output: OutputMode
}

// =============================================================================
// Timeline Folding
// =============================================================================

/** Fold all timeline events through the reducer to compute final state */
const foldTimeline = ({
  initial,
  timeline,
  reducer,
}: {
  readonly initial: unknown
  readonly timeline: readonly TimelineEvent<unknown>[]
  readonly reducer: (args: { state: unknown; action: unknown }) => unknown
}): unknown => {
  let state = initial
  const sorted = [...timeline].toSorted((a, b) => a.at - b.at)
  for (const event of sorted) {
    state = reducer({ state, action: event.action })
  }
  return state
}

/** Fold timeline events up to a specific timestamp */
const foldTimelineUntil = ({
  initial,
  timeline,
  reducer,
  until,
}: {
  readonly initial: unknown
  readonly timeline: readonly TimelineEvent<unknown>[]
  readonly reducer: (args: { state: unknown; action: unknown }) => unknown
  readonly until: number
}): unknown => {
  let state = initial
  const sorted = [...timeline].toSorted((a, b) => a.at - b.at)
  for (const event of sorted) {
    if (event.at > until) break
    state = reducer({ state, action: event.action })
  }
  return state
}

/** Compute the target state based on timeline mode */
const computeState = ({
  captured,
  timelineMode,
}: {
  readonly captured: CapturedStoryProps
  readonly timelineMode: TimelineMode
}): unknown => {
  const baseState = captured.initialState ?? captured.app.config.initial
  const { timeline } = captured
  const { reducer } = captured.app.config

  if (timelineMode === 'initial') return baseState
  if (timelineMode === 'final') return foldTimeline({ initial: baseState, timeline, reducer })
  return foldTimelineUntil({ initial: baseState, timeline, reducer, until: timelineMode.at })
}

// =============================================================================
// React Rendering (tty, alt-screen, ci, ci-plain, pipe, log)
// =============================================================================

/** Render via renderToString with the appropriate RenderConfig */
const renderReact = ({
  captured,
  width,
  timelineMode,
  output,
}: {
  readonly captured: CapturedStoryProps
  readonly width: number
  readonly timelineMode: TimelineMode
  readonly output: Exclude<OutputMode, 'json' | 'ndjson'>
}): Effect.Effect<string> =>
  Effect.promise(async () => {
    const targetState = computeState({ captured, timelineMode })
    const registry = AtomRegistry.make()
    const stateAtom = Atom.make(targetState)
    const { react, tuiReact } = await loadStoryRuntime(captured.storyFilePath)
    const renderConfig = {
      tty: tuiReact.ttyRenderConfig,
      'alt-screen': tuiReact.altScreenRenderConfig,
      ci: tuiReact.ciRenderConfig,
      'ci-plain': tuiReact.ciPlainRenderConfig,
      log: tuiReact.logRenderConfig,
    }[output]

    const viewElement = react.createElement(captured.View, { stateAtom })
    const configElement = react.createElement(
      tuiReact.RenderConfigProvider,
      { config: renderConfig },
      viewElement,
    )
    const element = react.createElement(
      tuiReact.TuiRegistryContext.Provider,
      { value: registry },
      configElement,
    )
    const raw = await tuiReact.renderToString({ element, options: { width } })

    return renderConfig.colors === false ? tuiReact.stripAnsi(raw) : raw
  })

// =============================================================================
// JSON Rendering
// =============================================================================

/** Encode an arbitrary (already schema-encoded) value to a JSON string. */
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
/** Same, but pretty-printed with a 2-space indent (json output mode). */
const encodeJsonPretty = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }))

/** Encode state as JSON via the app's stateSchema */
const renderJson = ({
  captured,
  timelineMode,
}: {
  readonly captured: CapturedStoryProps
  readonly timelineMode: TimelineMode
}): Effect.Effect<string> =>
  Effect.gen(function* () {
    const targetState = computeState({ captured, timelineMode })
    // Best-effort: encode through the app's schema, falling back to the raw
    // state on a schema mismatch (display-only path, never fails).
    const encoded = yield* Schema.encodeEffect(captured.app.config.stateSchema)(targetState).pipe(
      Effect.orElseSucceed(() => targetState),
    )
    return encodeJsonPretty(encoded)
  })

// =============================================================================
// NDJSON Rendering
// =============================================================================

/** Emit each timeline step as a newline-delimited JSON line */
const renderNdjson = ({
  captured,
}: {
  readonly captured: CapturedStoryProps
}): Effect.Effect<string> =>
  Effect.sync(() => {
    const baseState = captured.initialState ?? captured.app.config.initial
    const { timeline } = captured
    const { reducer, stateSchema } = captured.app.config

    const encode = (state: unknown): unknown => {
      try {
        return Schema.encodeSync(stateSchema)(state)
      } catch {
        return state
      }
    }

    const lines: string[] = []

    // Initial state line
    lines.push(encodeJson({ at: 0, state: encode(baseState) }))

    // Apply each timeline event and emit the resulting state
    let currentState = baseState
    const sorted = [...timeline].toSorted((a, b) => a.at - b.at)
    for (const event of sorted) {
      currentState = reducer({ state: currentState, action: event.action })
      lines.push(
        encodeJson({
          at: event.at,
          action: event.action,
          state: encode(currentState),
        }),
      )
    }

    return lines.join('\n')
  })

// =============================================================================
// Main Entry Point
// =============================================================================

/** Render a captured story to a string in the specified output mode */
export const renderStory = (options: RenderStoryOptions): Effect.Effect<string> => {
  const { captured, width, timelineMode, output } = options

  if (output === 'json') {
    return renderJson({ captured, timelineMode })
  }

  if (output === 'ndjson') {
    return renderNdjson({ captured })
  }

  return renderReact({
    captured,
    width,
    timelineMode,
    output,
  })
}
