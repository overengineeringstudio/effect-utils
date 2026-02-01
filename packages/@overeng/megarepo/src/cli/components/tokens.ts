/**
 * Megarepo CLI Visual Tokens
 *
 * Centralized visual constants for consistent CLI output.
 * Symbols are imported from @overeng/tui-react for consistency.
 */

import { unicodeSymbols } from '@overeng/tui-react'

// =============================================================================
// Symbols (re-exported for convenience)
// =============================================================================

/**
 * CLI symbols - shorthand accessors for common symbols.
 *
 * For React components, prefer `useSymbols()` hook for automatic
 * unicode/ascii fallback support based on RenderConfig.
 */
export const symbols = {
  // Status indicators
  check: unicodeSymbols.status.check,
  cross: unicodeSymbols.status.cross,
  circle: unicodeSymbols.status.circle,
  dot: unicodeSymbols.status.dot,
  warning: unicodeSymbols.status.warning,

  // Arrows
  arrow: unicodeSymbols.arrows.right,

  // Structural
  separator: unicodeSymbols.line.horizontal,
} as const

/**
 * @deprecated Use `symbols` instead
 */
export const icons = symbols

// =============================================================================
// Task Status Types
// =============================================================================

/** Generic task status for progress display */
export type TaskStatus = 'pending' | 'active' | 'success' | 'error' | 'skipped'

/** Sync-specific result status */
export type SyncResultStatus =
  | 'cloned'
  | 'synced'
  | 'updated'
  | 'locked'
  | 'already_synced'
  | 'skipped'
  | 'error'
  | 'removed'

// =============================================================================
// Status Configuration
// =============================================================================

export type StatusConfig = {
  icon: string | 'spinner'
  color?: 'green' | 'red' | 'yellow' | 'cyan' | 'blue' | 'magenta'
  dim?: boolean
}

/** Generic task status styling */
export const taskStatusConfig: Record<TaskStatus, StatusConfig> = {
  pending: { icon: symbols.circle, dim: true },
  active: { icon: 'spinner', color: 'cyan' },
  success: { icon: symbols.check, color: 'green' },
  error: { icon: symbols.cross, color: 'red' },
  skipped: { icon: symbols.circle, color: 'yellow' },
}

/** Sync result status styling */
export const syncStatusConfig: Record<SyncResultStatus, StatusConfig> = {
  cloned: { icon: symbols.check, color: 'green' },
  synced: { icon: symbols.check, color: 'green' },
  updated: { icon: symbols.check, color: 'green' },
  locked: { icon: symbols.check, color: 'cyan' },
  already_synced: { icon: symbols.check, dim: true },
  skipped: { icon: symbols.circle, color: 'yellow' },
  error: { icon: symbols.cross, color: 'red' },
  removed: { icon: symbols.cross, color: 'red' },
}

/** Map sync result status to task status for progress display */
export const syncToTaskStatus = (status: SyncResultStatus): TaskStatus => {
  switch (status) {
    case 'cloned':
    case 'synced':
    case 'updated':
    case 'locked':
    case 'already_synced':
    case 'removed':
      return 'success'
    case 'skipped':
      return 'skipped'
    case 'error':
      return 'error'
  }
}

// =============================================================================
// Log Types
// =============================================================================

export type LogType = 'info' | 'warn' | 'error'

export const logConfig: Record<LogType, { prefix: string; color: 'cyan' | 'yellow' | 'red' }> = {
  info: { prefix: 'i', color: 'cyan' },
  warn: { prefix: '!', color: 'yellow' },
  error: { prefix: '!', color: 'red' },
}
