/**
 * Storybook preview configuration for @overeng/megarepo
 *
 * Follows the same pattern as @overeng/tui-react - no global decorators.
 * Each story uses TuiStoryPreview directly in its render function.
 */

import type { Preview } from '@storybook/react'

const preview: Preview = {
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
}

export default preview
