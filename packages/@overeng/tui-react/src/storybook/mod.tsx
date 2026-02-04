/**
 * Storybook utilities for TUI React components
 *
 * @example
 * ```tsx
 * // App-based story with timeline playback
 * import { TuiStoryPreview } from '@overeng/tui-react/storybook'
 *
 * const MyApp = createTuiApp({ stateSchema, actionSchema, initial, reducer })
 *
 * export const MyStory = {
 *   render: () => (
 *     <TuiStoryPreview app={MyApp} View={MyView} timeline={events} />
 *   ),
 * }
 * ```
 *
 * @example
 * ```tsx
 * // Static component demo
 * import { TuiStoryPreview, createStaticApp } from '@overeng/tui-react/storybook'
 *
 * const StaticApp = createStaticApp()
 *
 * export const MyStory = {
 *   render: () => (
 *     <TuiStoryPreview app={StaticApp} View={() => <MyComponent />} initialState={null} />
 *   ),
 * }
 * ```
 */

export {
  TuiStoryPreview,
  type TuiStoryPreviewProps,
  type TimelineEvent,
  type OutputTab,
} from './TuiStoryPreview.tsx'
export { createStaticApp } from './static-app.ts'
export { tuiPreview } from './preview.ts'
export { xtermTheme, containerStyles, previewTextStyles } from './theme.ts'

import type { OutputTab, TimelineEvent } from './TuiStoryPreview.tsx'

/** All available output tabs for CLI storybooks */
export const ALL_OUTPUT_TABS: OutputTab[] = [
  'tty',
  'alt-screen',
  'ci',
  'ci-plain',
  'pipe',
  'log',
  'json',
  'ndjson',
]

/** Common argTypes for CLI storybooks with interactive timeline support */
export const commonArgTypes = {
  height: {
    description: 'Terminal height in pixels',
    control: { type: 'range', min: 200, max: 600, step: 50 },
  },
  interactive: {
    description: 'Enable animated timeline playback',
    control: { type: 'boolean' },
  },
  playbackSpeed: {
    description: 'Playback speed multiplier (when interactive)',
    control: { type: 'range', min: 0.5, max: 3, step: 0.5 },
    if: { arg: 'interactive' },
  },
} as const

/** Default args for CLI storybooks with interactive timeline support */
export const defaultStoryArgs = {
  height: 400,
  interactive: false,
  playbackSpeed: 1,
} as const

/**
 * Helper to create TuiStoryPreview props for interactive timeline stories.
 *
 * Handles the common pattern where:
 * - In interactive mode: starts from idle state and plays through timeline
 * - In static mode: shows the final state directly without animation
 *
 * @example
 * ```tsx
 * render: (args) => (
 *   <TuiStoryPreview
 *     View={MyView}
 *     app={MyApp}
 *     height={args.height}
 *     tabs={ALL_OUTPUT_TABS}
 *     {...createInteractiveProps({
 *       args,
 *       staticState: fixtures.createCompleteState(stateConfig),
 *       idleState: fixtures.createIdleState(),
 *       createTimeline: () => fixtures.createTimeline(stateConfig),
 *     })}
 *   />
 * )
 * ```
 */
export const createInteractiveProps = <S, A>(_: {
  args: { interactive: boolean; playbackSpeed: number }
  /** The final state to show in static mode */
  staticState: S
  /** The initial state to start from in interactive mode */
  idleState: S
  /** Factory to create timeline actions */
  createTimeline: () => TimelineEvent<A>[]
}): {
  initialState: S
  autoRun: boolean
  playbackSpeed: number
  timeline?: TimelineEvent<A>[]
} => ({
  initialState: _.args.interactive ? _.idleState : _.staticState,
  autoRun: _.args.interactive,
  playbackSpeed: _.args.playbackSpeed,
  ...(_.args.interactive ? { timeline: _.createTimeline() } : {}),
})
