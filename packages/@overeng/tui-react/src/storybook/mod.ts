/**
 * Storybook utilities for TUI React components
 *
 * @example
 * ```ts
 * // Use the pre-configured preview in .storybook/preview.tsx
 * import { tuiPreview } from '@overeng/tui-react/storybook'
 * export default tuiPreview
 * ```
 *
 * @example
 * ```tsx
 * // Simple mode - just wrap children in terminal preview
 * import { TuiStoryPreview } from '@overeng/tui-react/storybook'
 *
 * export const MyStory = {
 *   render: () => (
 *     <TuiStoryPreview>
 *       <Box><Text>Hello</Text></Box>
 *     </TuiStoryPreview>
 *   ),
 * }
 * ```
 *
 * @example
 * ```tsx
 * // Stateful mode - full state management with timeline
 * import { TuiStoryPreview } from '@overeng/tui-react/storybook'
 * import { MyView, MyState, MyAction, myReducer } from './my-example'
 *
 * export const MyStory = {
 *   render: () => (
 *     <TuiStoryPreview
 *       View={MyView}
 *       stateSchema={MyState}
 *       actionSchema={MyAction}
 *       reducer={myReducer}
 *       initialState={initialState}
 *       timeline={events}
 *     />
 *   ),
 * }
 * ```
 *
 * @example
 * ```tsx
 * // CLI component with createCliMeta helper
 * import { createCliMeta, TerminalPreview } from '@overeng/tui-react/storybook'
 *
 * const meta = createCliMeta<MyOutputProps>(MyOutput, {
 *   title: 'CLI/MyOutput',
 *   description: 'Output for my command',
 *   defaultArgs: { status: 'success' },
 * })
 *
 * export default meta
 * ```
 */

export {
  TuiStoryPreview,
  type TuiStoryPreviewProps,
  type TimelineEvent,
  type OutputTab,
} from './TuiStoryPreview.tsx'
export { tuiPreview } from './preview.ts'
export { xtermTheme, containerStyles, previewTextStyles } from './theme.ts'

// CLI utilities
export {
  TerminalPreview,
  StringTerminalPreview,
  createCliMeta,
  type TerminalPreviewProps,
  type StringTerminalPreviewProps,
  type CreateCliMetaOptions,
  type CliStoryMeta,
  type CliStory,
} from './cli-utils.tsx'
