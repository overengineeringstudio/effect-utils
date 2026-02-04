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

import type { OutputTab } from './TuiStoryPreview.tsx'

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
