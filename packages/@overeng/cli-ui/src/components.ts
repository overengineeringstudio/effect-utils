/**
 * CLI Components
 *
 * Reusable building blocks for CLI output.
 * Single-line components return string, multi-line return string[].
 */

import { styled } from './styled.ts'
import { bgColor256, colors, symbols } from './tokens.ts'
import { visibleLength } from './utils.ts'

// =============================================================================
// Badge Component
// =============================================================================

/** Badge severity level */
export type BadgeLevel = 'critical' | 'error' | 'warning' | 'success' | 'info'

const badgeStyles: Record<BadgeLevel, { bg: string; fg: string }> = {
  critical: { bg: colors.bgRed, fg: colors.white },
  error: { bg: colors.bgRed, fg: colors.white },
  warning: { bg: colors.bgYellow, fg: colors.black },
  success: { bg: colors.bgGreen, fg: colors.black },
  info: { bg: colors.bgBlue, fg: colors.white },
}

/** Render a colored badge/pill (single line) */
// oxlint-disable-next-line overeng/named-args -- simple component with clear positional args
export const badge = (text: string, level: BadgeLevel): string => {
  const style = badgeStyles[level]
  return `${style.bg}${style.fg}${colors.bold} ${text} ${colors.reset}`
}

// =============================================================================
// List Component
// =============================================================================

/** Options for rendering a list */
export type ListOptions = {
  /** Maximum items to show before truncating */
  max?: number
  /** Indentation string */
  indent?: string
  /** Style function for items */
  itemStyle?: (item: string) => string
  /** Custom "more" text format */
  moreText?: (remaining: number) => string
}

const defaultListOptions: Required<ListOptions> = {
  max: 5,
  indent: '',
  itemStyle: styled.cyan,
  moreText: (n) => `+ ${n} more`,
}

/** Render a list with optional truncation (multi-line) */
// oxlint-disable-next-line overeng/named-args -- items + options is idiomatic
export const list = (items: string[], options?: ListOptions): string[] => {
  const opts = { ...defaultListOptions, ...options }
  const lines: string[] = []

  const shown = items.slice(0, opts.max)
  const remaining = items.length - opts.max

  for (const item of shown) {
    lines.push(`${opts.indent}${opts.itemStyle(item)}`)
  }

  if (remaining > 0) {
    lines.push(`${opts.indent}${styled.dim(opts.moreText(remaining))}`)
  }

  return lines
}

// =============================================================================
// Key-Value Component
// =============================================================================

/** Options for key-value rendering */
export type KvOptions = {
  /** Separator between key and value */
  separator?: string
  /** Style function for key */
  keyStyle?: (key: string) => string
  /** Style function for value */
  valueStyle?: (value: string) => string
}

const defaultKvOptions: Required<KvOptions> = {
  separator: ': ',
  keyStyle: styled.dim,
  valueStyle: (v) => v,
}

/** Render a key-value pair (single line) */
// oxlint-disable-next-line overeng/named-args -- key + value + options is idiomatic
export const kv = (key: string, value: string, options?: KvOptions): string => {
  const opts = { ...defaultKvOptions, ...options }
  return `${opts.keyStyle(key)}${opts.separator}${opts.valueStyle(value)}`
}

// =============================================================================
// Separator Component
// =============================================================================

/** Options for separator rendering */
export type SeparatorOptions = {
  /** Width of separator */
  width?: number
  /** Character to use */
  char?: string
  /** Style function */
  style?: (s: string) => string
}

const defaultSeparatorOptions: Required<SeparatorOptions> = {
  width: 40,
  char: symbols.separator,
  style: styled.dim,
}

/** Render a horizontal separator line (single line) */
export const separator = (options?: SeparatorOptions): string => {
  const opts = { ...defaultSeparatorOptions, ...options }
  return opts.style(opts.char.repeat(opts.width))
}

// =============================================================================
// Status Indicator Component
// =============================================================================

/** Status indicator level */
export type StatusLevel = 'success' | 'error' | 'warning' | 'info' | 'pending'

const statusSymbols: Record<StatusLevel, string> = {
  success: symbols.check,
  error: symbols.cross,
  warning: symbols.warning,
  info: symbols.info,
  pending: symbols.circle,
}

const statusStyles: Record<StatusLevel, (s: string) => string> = {
  success: styled.green,
  error: styled.red,
  warning: styled.yellow,
  info: styled.blue,
  pending: styled.dim,
}

/** Render a status indicator with optional label (single line) */
// oxlint-disable-next-line overeng/named-args -- level + optional label is clear
export const status = (level: StatusLevel, label?: string): string => {
  const symbol = statusStyles[level](statusSymbols[level])
  return label ? `${symbol} ${label}` : symbol
}

// =============================================================================
// Indented Block Component
// =============================================================================

/** Options for indentation */
export type IndentOptions = {
  /** Number of spaces per indent level */
  size?: number
  /** Indent level */
  level?: number
}

/** Indent a single line */
// oxlint-disable-next-line overeng/named-args -- text + options is idiomatic
export const indent = (text: string, options?: IndentOptions): string => {
  const size = options?.size ?? 2
  const level = options?.level ?? 1
  return `${' '.repeat(size * level)}${text}`
}

/** Indent multiple lines */
// oxlint-disable-next-line overeng/named-args -- lines + options is idiomatic
export const indentLines = (lines: string[], options?: IndentOptions): string[] => {
  return lines.map((line) => indent(line, options))
}

// =============================================================================
// Labeled Section Component
// =============================================================================

/** Options for labeled section rendering */
export type SectionOptions = {
  /** Indent for content lines */
  contentIndent?: number
}

/** Render a labeled section with content (multi-line) */
// oxlint-disable-next-line overeng/named-args -- label + content + options is idiomatic
export const section = (label: string, content: string[], options?: SectionOptions): string[] => {
  const contentIndent = options?.contentIndent ?? 2
  const lines: string[] = [styled.bold(label)]

  for (const line of content) {
    lines.push(`${' '.repeat(contentIndent)}${line}`)
  }

  return lines
}

// =============================================================================
// Git Diff Component
// =============================================================================

/** Git diff statistics */
export type GitDiffData = {
  added: number
  removed: number
}

/** Render a git diff summary (+N/-M format) */
export const gitDiff = (diff: GitDiffData): string =>
  `${styled.green(`+${diff.added}`)}${styled.dim('/')}${styled.red(`-${diff.removed}`)}`

// =============================================================================
// Highlighted Line Component
// =============================================================================

/** ANSI escape code to clear from cursor to end of line */
const CLEAR_TO_EOL = '\x1b[K'

/** Options for highlighted line rendering */
export type HighlightLineOptions = {
  /** Background color (256-color palette, 0-255). Default: 236 (dark gray) */
  bgColor?: number
  /** Minimum width to pad to. If undefined, uses terminal width or 80 */
  minWidth?: number
}

/**
 * Highlight a line with a background color that extends to the full terminal width.
 * Creates a solid rectangle of background color behind the text.
 *
 * Handles nested ANSI styles by re-applying the background after each reset code.
 *
 * @example
 * ```ts
 * console.log(highlightLine('Current item'))
 * console.log(highlightLine('Selected', { bgColor: 238 }))
 * console.log(highlightLine(styled.bold('Bold') + ' text')) // Background persists through styled text
 * ```
 */
export const highlightLine = (text: string, options?: HighlightLineOptions): string => {
  const bgColorCode = options?.bgColor ?? 236
  const bg = bgColor256(bgColorCode)

  // Get terminal width, fallback to minWidth or 80
  const termWidth =
    (typeof process !== 'undefined' && process.stdout?.columns) || options?.minWidth || 80
  const minWidth = options?.minWidth ?? termWidth

  // Calculate padding needed
  const textWidth = visibleLength(text)
  const padding = Math.max(0, minWidth - textWidth)

  // Replace all reset codes (\x1b[0m) with reset + re-apply background
  // This ensures the background persists through nested styled text
  const textWithBg = text.replace(/\x1b\[0m/g, `${colors.reset}${bg}`)

  // Apply background, modified text, padding, clear to EOL, then final reset
  // The CLEAR_TO_EOL ensures the background extends to the edge of the terminal
  return `${bg}${textWithBg}${' '.repeat(padding)}${CLEAR_TO_EOL}${colors.reset}`
}
