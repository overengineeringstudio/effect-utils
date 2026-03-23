/**
 * Render a captured story to output.
 *
 * Supports all output modes matching the web Storybook tabs:
 * - tty/alt-screen/ci/ci-plain/pipe/log: React rendering with different RenderConfigs
 * - json: Final state encoded via Schema
 * - ndjson: Timeline events as newline-delimited JSON
 */

import { Atom, Registry } from '@effect-atom/atom'
import { Effect, Schema } from 'effect'
import React from 'react'

import {
  RenderConfigProvider,
  ttyRenderConfig,
  ciRenderConfig,
  ciPlainRenderConfig,
  pipeRenderConfig,
  logRenderConfig,
  altScreenRenderConfig,
  stripAnsi,
  type RenderConfig,
  TuiRegistryContext,
  renderToString,
} from '@overeng/tui-react'
import type { TimelineEvent } from '@overeng/tui-react/storybook'

import type { CapturedStoryProps } from './StoryCapture.ts'

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
 * - pipe: static spinners, colors (final timing)
 * - log: static spinners, no colors (final timing)
 *
 * Data modes (state serialized as JSON):
 * - json: final state encoded via stateSchema
 * - ndjson: each timeline step encoded as a JSON line
 */
export type OutputMode =
  | 'tty'
  | 'alt-screen'
  | 'ci'
  | 'ci-plain'
  | 'pipe'
  | 'log'
  | 'json'
  | 'ndjson'

/** All valid output mode values */
export const OUTPUT_MODES = [
  'tty',
  'alt-screen',
  'ci',
  'ci-plain',
  'pipe',
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
// RenderConfig mapping
// =============================================================================

const renderConfigForMode: Record<Exclude<OutputMode, 'json' | 'ndjson'>, RenderConfig> = {
  tty: ttyRenderConfig,
  'alt-screen': altScreenRenderConfig,
  ci: ciRenderConfig,
  'ci-plain': ciPlainRenderConfig,
  pipe: pipeRenderConfig,
  log: logRenderConfig,
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
  renderConfig,
}: {
  readonly captured: CapturedStoryProps
  readonly width: number
  readonly timelineMode: TimelineMode
  readonly renderConfig: RenderConfig
}): Effect.Effect<string> =>
  Effect.gen(function* () {
    const targetState = computeState({ captured, timelineMode })
    const registry = Registry.make()
    const stateAtom = Atom.make(targetState)

    const viewElement = React.createElement(captured.View, { stateAtom })
    const configElement = React.createElement(
      RenderConfigProvider,
      { config: renderConfig } as React.ComponentProps<typeof RenderConfigProvider>,
      viewElement,
    )
    const element = React.createElement(
      TuiRegistryContext.Provider,
      { value: registry },
      configElement,
    )

    const raw = yield* Effect.promise(() => renderToString({ element, options: { width } }))

    // Strip ANSI for modes with colors disabled (components may emit ANSI directly)
    return renderConfig.colors === false ? stripAnsi(raw) : raw
  })

// =============================================================================
// JSON Rendering
// =============================================================================

/** Encode state as JSON via the app's stateSchema */
const renderJson = ({
  captured,
  timelineMode,
}: {
  readonly captured: CapturedStoryProps
  readonly timelineMode: TimelineMode
}): Effect.Effect<string> =>
  Effect.sync(() => {
    const targetState = computeState({ captured, timelineMode })
    try {
      const encoded = Schema.encodeSync(captured.app.config.stateSchema)(targetState)
      return JSON.stringify(encoded, null, 2)
    } catch {
      return JSON.stringify(targetState, null, 2)
    }
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
    lines.push(JSON.stringify({ at: 0, state: encode(baseState) }))

    // Apply each timeline event and emit the resulting state
    let currentState = baseState
    const sorted = [...timeline].toSorted((a, b) => a.at - b.at)
    for (const event of sorted) {
      currentState = reducer({ state: currentState, action: event.action })
      lines.push(
        JSON.stringify({
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
    renderConfig: renderConfigForMode[output],
  })
}
