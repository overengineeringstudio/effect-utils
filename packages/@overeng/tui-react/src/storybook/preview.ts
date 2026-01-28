/**
 * Pre-configured Storybook preview for TUI React components
 */

import type { Preview } from '@storybook/react'

import { withTerminalPreview } from './decorator.tsx'

/**
 * Default TUI Storybook preview configuration
 *
 * Usage in .storybook/preview.tsx:
 * ```ts
 * import { tuiPreview } from '@overeng/tui-react/storybook'
 * export default tuiPreview
 * ```
 *
 * Or extend it:
 * ```ts
 * import { tuiPreview } from '@overeng/tui-react/storybook'
 * export default {
 *   ...tuiPreview,
 *   parameters: {
 *     ...tuiPreview.parameters,
 *     // your custom parameters
 *   },
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
  decorators: [withTerminalPreview],
}
