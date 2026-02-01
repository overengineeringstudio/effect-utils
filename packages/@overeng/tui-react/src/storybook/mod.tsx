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
