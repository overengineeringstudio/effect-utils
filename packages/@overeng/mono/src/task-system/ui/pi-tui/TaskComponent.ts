/**
 * Individual task rendering for pi-tui.
 *
 * Renders a single task with two-column layout: status | log output
 */

import { truncateToWidth, visibleWidth } from '@mariozechner/pi-tui'

import type { TaskState } from '../../types.ts'
import { renderStatusString } from './StatusRenderer.ts'

/** ANSI color codes */
const COLORS = {
  gray: '\x1b[90m',
  dimGray: '\x1b[2m\x1b[90m',
  reset: '\x1b[0m',
} as const

/**
 * Get the latest log line from a task.
 * Combines stdout and stderr, returns the most recent line.
 */
const getLatestLogLine = (task: TaskState): string => {
  const allOutput = [...task.stdout, ...task.stderr]
  return allOutput[allOutput.length - 1] || ''
}

/**
 * Check if a task should show its log output.
 * Only running or failed tasks with output show logs.
 */
const shouldShowLog = (task: TaskState): boolean => {
  const latestLog = getLatestLogLine(task)
  return (task.status === 'running' || task.status === 'failed') && latestLog.length > 0
}

/**
 * Render a single task as a string line.
 *
 * Layout: [status column] │ [log column]
 */
export const renderTask = ({
  task,
  spinnerFrame,
  width,
}: {
  task: TaskState
  spinnerFrame: number
  width: number
}): string => {
  // Left column: Status
  const statusStr = renderStatusString({ task, spinnerFrame })

  // Right column: Latest log (if applicable)
  const showLog = shouldShowLog(task)
  const separator = ` ${COLORS.gray}│${COLORS.reset} `

  if (!showLog) {
    // No log - just render status
    return truncateToWidth(statusStr, width)
  }

  // Calculate available space for log
  const statusWidth = visibleWidth(statusStr)
  const separatorWidth = visibleWidth(separator)
  const logAvailableWidth = width - statusWidth - separatorWidth

  if (logAvailableWidth <= 0) {
    // Not enough space for log, just show status
    return truncateToWidth(statusStr, width)
  }

  // Render log with truncation
  const latestLog = getLatestLogLine(task)
  const logStr = `${COLORS.dimGray}${latestLog}${COLORS.reset}`
  const truncatedLog = truncateToWidth(logStr, logAvailableWidth)

  return `${statusStr}${separator}${truncatedLog}`
}
