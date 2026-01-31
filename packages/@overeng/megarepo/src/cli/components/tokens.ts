/**
 * Megarepo CLI Visual Tokens
 *
 * Centralized visual constants for consistent CLI output.
 */

// =============================================================================
// Icons
// =============================================================================

export const icons = {
  // Status indicators
  check: '\u2713', // ✓
  cross: '\u2717', // ✗
  circle: '\u25cb', // ○
  dot: '\u00b7', // ·

  // Arrows
  arrow: '\u2192', // →

  // Structural
  separator: '\u2500', // ─
} as const

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
  pending: { icon: icons.circle, dim: true },
  active: { icon: 'spinner', color: 'cyan' },
  success: { icon: icons.check, color: 'green' },
  error: { icon: icons.cross, color: 'red' },
  skipped: { icon: icons.circle, color: 'yellow' },
}

/** Sync result status styling */
export const syncStatusConfig: Record<SyncResultStatus, StatusConfig> = {
  cloned: { icon: icons.check, color: 'green' },
  synced: { icon: icons.check, color: 'green' },
  updated: { icon: icons.check, color: 'green' },
  locked: { icon: icons.check, color: 'cyan' },
  already_synced: { icon: icons.check, dim: true },
  skipped: { icon: icons.circle, color: 'yellow' },
  error: { icon: icons.cross, color: 'red' },
  removed: { icon: icons.cross, color: 'red' },
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
