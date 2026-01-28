/**
 * Storybook decorator for TUI React components
 */

import type { Decorator } from '@storybook/react'
import React from 'react'

import { TerminalPreview } from './TerminalPreview.tsx'

/**
 * Storybook decorator that wraps stories in TerminalPreview
 *
 * Usage in preview.tsx:
 * ```ts
 * import { withTerminalPreview } from '@overeng/tui-react/storybook'
 *
 * export default {
 *   decorators: [withTerminalPreview],
 * }
 * ```
 */
export const withTerminalPreview: Decorator = (Story) => (
  <TerminalPreview>
    <Story />
  </TerminalPreview>
)
