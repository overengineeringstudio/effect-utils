/**
 * Storybook utilities for TUI React components
 *
 * @example
 * ```ts
 * // Simple usage - just use the pre-configured preview
 * import { tuiPreview } from '@overeng/tui-react/storybook'
 * export default tuiPreview
 * ```
 *
 * @example
 * ```ts
 * // Custom usage - compose your own preview
 * import { withTerminalPreview, TerminalPreview, xtermTheme } from '@overeng/tui-react/storybook'
 *
 * export default {
 *   decorators: [withTerminalPreview],
 *   // ...
 * }
 * ```
 */

export { TerminalPreview, type TerminalPreviewProps } from './TerminalPreview.tsx'
export { withTerminalPreview } from './decorator.tsx'
export { tuiPreview } from './preview.ts'
export { xtermTheme, containerStyles } from './theme.ts'
