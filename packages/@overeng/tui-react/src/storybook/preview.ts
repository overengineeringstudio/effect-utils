/**
 * Pre-configured Storybook preview for TUI React components
 */

import type { Preview } from '@storybook/react'

/**
 * Default TUI Storybook preview configuration
 *
 * NOTE: No global decorator is applied. Stories must explicitly wrap their
 * content with TerminalPreview, TuiStoryPreview, or similar components.
 * This prevents double-wrapping issues and makes each story's rendering explicit.
 *
 * Usage in .storybook/preview.tsx:
 * ```ts
 * import { tuiPreview } from '@overeng/tui-react/storybook'
 * export default tuiPreview
 * ```
 *
 * In your stories:
 * ```tsx
 * import { TerminalPreview } from '@overeng/tui-react/storybook'
 *
 * export const MyStory = {
 *   render: () => (
 *     <TerminalPreview>
 *       <Box><Text>Hello</Text></Box>
 *     </TerminalPreview>
 *   ),
 * }
 * ```
 */
export const tuiPreview: Preview = {
  parameters: {
    layout: 'padded',
    backgrounds: {
      default: 'dark',
      values: [
        { name: 'dark', value: '#0d1117' },
        { name: 'light', value: '#ffffff' },
      ],
    },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
  },
  // No global decorators - stories explicitly wrap with TerminalPreview
}
