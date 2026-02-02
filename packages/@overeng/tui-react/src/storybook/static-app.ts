/**
 * createStaticApp - Factory for static/stateless component previews.
 *
 * Creates a minimal TuiApp with null state and no actions,
 * suitable for storybook stories that just render static components.
 *
 * @example
 * ```tsx
 * import { createStaticApp } from '@overeng/tui-react/storybook'
 *
 * const StaticApp = createStaticApp()
 *
 * export const MyStory = {
 *   render: () => (
 *     <TuiStoryPreview
 *       app={StaticApp}
 *       View={() => <Box><Text>Hello</Text></Box>}
 *       initialState={null}
 *     />
 *   ),
 * }
 * ```
 */

import { Schema } from 'effect'

import { createTuiApp } from '../effect/TuiApp.tsx'

/** Creates a minimal TuiApp with null state for previewing stateless components in Storybook. */
export const createStaticApp = () =>
  createTuiApp({
    stateSchema: Schema.Null,
    actionSchema: Schema.Never,
    initial: null,
    reducer: ({ state }) => state,
  })
