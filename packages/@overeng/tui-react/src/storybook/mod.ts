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
 *
 * @example
 * ```ts
 * // CLI component stories - use createCliMeta for minimal boilerplate
 * import { createCliMeta } from '@overeng/tui-react/storybook'
 * import { MyOutput, type MyOutputProps } from './MyOutput.tsx'
 *
 * const meta = createCliMeta(MyOutput, {
 *   title: 'CLI/MyOutput',
 *   defaultArgs: { ... },
 * })
 * export default meta
 * ```
 */

export { TerminalPreview, type TerminalPreviewProps } from './TerminalPreview.tsx'
export { StringTerminalPreview, type StringTerminalPreviewProps } from './StringTerminalPreview.tsx'
export { createCliMeta, type CliMetaConfig, type CliMetaProps, type RenderMode } from './createCliMeta.tsx'
export { withTerminalPreview } from './decorator.tsx'
export { tuiPreview } from './preview.ts'
export { xtermTheme, containerStyles } from './theme.ts'
