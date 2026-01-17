/**
 * Status rendering utilities for pi-tui components.
 *
 * Handles status icons, colors, spinners, and timing information.
 */

import { Option } from 'effect'

import type { TaskState, TaskStatus } from '../../types.ts'

/** ANSI color codes */
const COLORS = {
  white: '\x1b[37m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  reset: '\x1b[0m',
} as const

/** Spinner frames for animated progress */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

/**
 * Get status icon for a given task state.
 */
export const getStatusIcon = ({
  status,
  spinnerFrame,
}: {
  status: TaskStatus
  spinnerFrame: number
}): string => {
  if (status === 'pending') return SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]!
  if (status === 'running') return SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]!
  if (status === 'success') return '✓'
  if (status === 'failed') return '✗'
  return '○' // fallback
}

/**
 * Get ANSI color code for a given task status.
 */
export const getStatusColor = (status: TaskStatus): string => {
  if (status === 'pending') return COLORS.white
  if (status === 'running') return COLORS.cyan
  if (status === 'success') return COLORS.green
  if (status === 'failed') return COLORS.red
  return COLORS.white // fallback
}

/**
 * Format duration string from task timestamps.
 */
export const formatDuration = (task: TaskState): string => {
  return Option.match(task.startedAt, {
    onNone: () => '',
    onSome: (start) =>
      Option.match(task.completedAt, {
        onNone: () => ` (${((Date.now() - start) / 1000).toFixed(1)}s)`,
        onSome: (end) => ` (${((end - start) / 1000).toFixed(1)}s)`,
      }),
  })
}

/**
 * Format retry attempt info.
 */
export const formatRetryInfo = (task: TaskState): string => {
  return Option.match(task.maxRetries, {
    onNone: () => '',
    onSome: (maxRetries) =>
      task.retryAttempt > 0 ? ` [retry ${task.retryAttempt}/${maxRetries}]` : '',
  })
}

/**
 * Render complete status string with icon, name, duration, and retry info.
 */
export const renderStatusString = ({
  task,
  spinnerFrame,
}: {
  task: TaskState
  spinnerFrame: number
}): string => {
  const color = getStatusColor(task.status)
  const icon = getStatusIcon({ status: task.status, spinnerFrame })
  const duration = formatDuration(task)
  const retryInfo = formatRetryInfo(task)

  return `${color}${icon} ${task.name}${duration}${retryInfo}${COLORS.reset}`
}
