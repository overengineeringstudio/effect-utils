/**
 * @overeng/cli-ui
 *
 * A CLI design system with tokens, styled text functions, and components.
 *
 * @example
 * ```ts
 * import { styled, badge, list, kv, separator, symbols } from '@overeng/cli-ui'
 *
 * // Styled text
 * console.log(styled.bold('Hello'))
 * console.log(styled.red('Error!'))
 *
 * // Badge
 * console.log(badge('CRITICAL', 'critical'))
 *
 * // Key-value
 * console.log(kv('workspace', 'my-project'))
 *
 * // List with truncation
 * const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
 * list(items, { max: 5 }).forEach(line => console.log(line))
 *
 * // Separator
 * console.log(separator())
 * ```
 */

// Tokens
export { colors, color256, bgColor256, symbols, spacing, semantic } from './tokens.ts'

// Color support detection
export {
  getColorLevel,
  supportsColor,
  supports256Colors,
  supportsTruecolor,
  forceColorLevel,
  resetColorCache,
  resetColorState,
  type ColorLevel,
} from './color-support.ts'

// Styled text functions
export { styled, raw } from './styled.ts'

// Components
export {
  badge,
  list,
  kv,
  separator,
  status,
  indent,
  indentLines,
  section,
  gitDiff,
  highlightLine,
  type BadgeLevel,
  type ListOptions,
  type KvOptions,
  type SeparatorOptions,
  type StatusLevel,
  type IndentOptions,
  type SectionOptions,
  type GitDiffData,
  type HighlightLineOptions,
} from './components.ts'

// Utilities
export {
  stripAnsi,
  visibleLength,
  padEnd,
  padStart,
  center,
  truncate,
  wrap,
  joinLines,
  splitLines,
  type PadOptions,
  type TruncateOptions,
} from './utils.ts'

// Progress indicators
export {
  progress,
  spinner,
  spinnerFrames,
  progressSymbols,
  formatElapsed,
  type ProgressOptions,
} from './progress.ts'

// Progress list (multi-line live updates)
export {
  createProgressListState,
  renderProgressList,
  formatProgressSummary,
  isTTY,
  startProgressList,
  updateProgressList,
  finishProgressList,
  startSpinner,
  updateItemStatus,
  markActive,
  markSuccess,
  markError,
  isComplete,
  getStatusCounts,
  type ProgressItemStatus,
  type ProgressItem,
  type ProgressListOptions,
  type ProgressListState,
} from './progress-list.ts'

// ANSI escape code helpers
export {
  cursorUp,
  cursorDown,
  cursorToStart,
  cursorToColumn,
  clearToEOL,
  clearToBOL,
  clearLine,
  hideCursor,
  showCursor,
  write,
  writeLine,
  rewriteLine,
  clearLinesAbove,
} from './ansi.ts'

// Tree rendering helpers
export {
  treeChars,
  treeCharsAscii,
  buildTreePrefix,
  buildContinuationPrefix,
  flattenTree,
  buildTree,
  type TreeNode,
  type FlatTreeItem,
} from './tree.ts'

// Tree progress (hierarchical live updates)
export {
  createTreeProgressState,
  renderTreeProgress,
  formatTreeProgressSummary,
  startTreeProgress,
  updateTreeProgress,
  finishTreeProgress,
  startTreeSpinner,
  updateTreeItemStatus,
  markTreeItemActive,
  markTreeItemSuccess,
  markTreeItemError,
  markTreeItemSkipped,
  addTreeItem,
  removeTreeItem,
  isTreeComplete,
  getTreeStatusCounts,
  getTreeElapsed,
  getTreeItemsByStatus,
  getTreeChildren,
  type TreeProgressStatus,
  type TreeProgressItem,
  type TreeProgressOptions,
  type TreeProgressState,
} from './tree-progress.ts'
