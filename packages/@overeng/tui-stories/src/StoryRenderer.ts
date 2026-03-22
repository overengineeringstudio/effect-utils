/**
 * Render a captured story to ANSI string output.
 *
 * Reuses the same rendering pipeline as TuiStoryPreview's
 * CI/Pipe/Log output panes: creates an atom with the computed state,
 * wraps the View in the proper contexts, and calls renderToString.
 */

import { Atom, Registry } from '@effect-atom/atom'
import { Effect } from 'effect'
import React from 'react'

import {
  RenderConfigProvider,
  stripAnsi,
  ciRenderConfig,
  logRenderConfig,
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

/** Options for rendering a story */
export interface RenderStoryOptions {
  readonly captured: CapturedStoryProps
  readonly width: number
  readonly timelineMode: TimelineMode
  readonly plain: boolean
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

// =============================================================================
// Rendering
// =============================================================================

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

/** Render a captured story to a string */
export const renderStory = (options: RenderStoryOptions): Effect.Effect<string> =>
  Effect.gen(function* () {
    const { captured, width, timelineMode, plain } = options

    const targetState = computeState({ captured, timelineMode })

    const registry = Registry.make()
    const stateAtom = Atom.make(targetState)

    const renderConfig: RenderConfig = plain === true ? logRenderConfig : ciRenderConfig

    const viewElement = React.createElement(captured.View, { stateAtom })
    // oxlint-disable-next-line eslint-plugin-react(no-children-prop) -- .ts file, no JSX available
    const configElement = React.createElement(RenderConfigProvider, {
      config: renderConfig,
      children: viewElement,
    })
    const element = React.createElement(
      TuiRegistryContext.Provider,
      { value: registry },
      configElement,
    )

    const output = yield* Effect.promise(() => renderToString({ element, options: { width } }))

    return plain === true ? stripAnsi(output) : output
  })
