/**
 * CLI Components
 *
 * Reusable building blocks for CLI output.
 * Single-line components return string, multi-line return string[].
 */

import { styled } from './styled.ts'
import { colors, symbols } from './tokens.ts'

// =============================================================================
// Badge Component
// =============================================================================

export type BadgeLevel = 'critical' | 'error' | 'warning' | 'success' | 'info'

const badgeStyles: Record<BadgeLevel, { bg: string; fg: string }> = {
  critical: { bg: colors.bgRed, fg: colors.white },
  error: { bg: colors.bgRed, fg: colors.white },
  warning: { bg: colors.bgYellow, fg: colors.black },
  success: { bg: colors.bgGreen, fg: colors.black },
  info: { bg: colors.bgBlue, fg: colors.white },
}

/** Render a colored badge/pill (single line) */
export const badge = (text: string, level: BadgeLevel): string => {
  const style = badgeStyles[level]
  return `${style.bg}${style.fg}${colors.bold} ${text} ${colors.reset}`
}

// =============================================================================
// List Component
// =============================================================================

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
export const kv = (key: string, value: string, options?: KvOptions): string => {
  const opts = { ...defaultKvOptions, ...options }
  return `${opts.keyStyle(key)}${opts.separator}${opts.valueStyle(value)}`
}

// =============================================================================
// Separator Component
// =============================================================================

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
export const status = (level: StatusLevel, label?: string): string => {
  const symbol = statusStyles[level](statusSymbols[level])
  return label ? `${symbol} ${label}` : symbol
}

// =============================================================================
// Indented Block Component
// =============================================================================

export type IndentOptions = {
  /** Number of spaces per indent level */
  size?: number
  /** Indent level */
  level?: number
}

/** Indent a single line */
export const indent = (text: string, options?: IndentOptions): string => {
  const size = options?.size ?? 2
  const level = options?.level ?? 1
  return `${' '.repeat(size * level)}${text}`
}

/** Indent multiple lines */
export const indentLines = (lines: string[], options?: IndentOptions): string[] => {
  return lines.map((line) => indent(line, options))
}

// =============================================================================
// Labeled Section Component
// =============================================================================

export type SectionOptions = {
  /** Indent for content lines */
  contentIndent?: number
}

/** Render a labeled section with content (multi-line) */
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

export type GitDiffData = {
  added: number
  removed: number
}

/** Render a git diff summary (+N/-M format) */
export const gitDiff = (diff: GitDiffData): string =>
  `${styled.green(`+${diff.added}`)}${styled.dim('/')}${styled.red(`-${diff.removed}`)}`
