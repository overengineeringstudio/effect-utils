/**
 * Storybook preview configuration for @overeng/megarepo
 *
 * Uses the shared TUI Storybook utilities from @overeng/tui-react,
 * but with custom handling for string render mode.
 */

import type { Preview, Decorator } from '@storybook/react'
import React from 'react'
import { TerminalPreview } from '@overeng/tui-react/storybook'

/**
 * Custom decorator that conditionally applies terminal preview.
 * When args.renderMode === 'string', renders directly to DOM.
 * Otherwise, renders through the terminal preview.
 */
const withConditionalTerminalPreview: Decorator = (Story, context) => {
  const renderMode = context.args?.renderMode

  // String mode: render directly to DOM (no terminal wrapper)
  if (renderMode === 'string') {
    return <Story />
  }

  // TTY mode: render through terminal preview
  return (
    <TerminalPreview>
      <Story />
    </TerminalPreview>
  )
}

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
  decorators: [withConditionalTerminalPreview],
}

export default preview
