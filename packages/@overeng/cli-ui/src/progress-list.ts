/**
 * Progress List Component
 *
 * A component for displaying a list of items with live progress updates.
 * Uses ANSI escape codes to update lines in place.
 */

import {
  clearToEOL,
  cursorToStart,
  cursorUp,
  hideCursor,
  isTTY,
  showCursor,
  write,
  writeLine,
} from './ansi.ts'
import { spinner } from './progress.ts'
import { styled } from './styled.ts'
import { symbols } from './tokens.ts'

// Re-export isTTY for backwards compatibility
export { isTTY } from './ansi.ts'

// =============================================================================
// Types
// =============================================================================

/** Status of an item in the progress list */
export type ProgressItemStatus = 'pending' | 'active' | 'success' | 'error'

/** An item in the progress list */
export type ProgressItem<T = unknown> = {
  /** Unique identifier */
  id: string
  /** Display label */
  label: string
  /** Current status */
  status: ProgressItemStatus
  /** Optional message (shown for active/error states) */
  message?: string | undefined
  /** Optional data associated with the item */
  data?: T
}

/** Options for the progress list */
export type ProgressListOptions = {
  /** Spinner frame interval in ms (default: 80) */
  spinnerInterval?: number
}

// =============================================================================
// Progress List State
// =============================================================================

/** State for managing a progress list */
export type ProgressListState<T = unknown> = {
  /** All items */
  items: ProgressItem<T>[]
  /** Current spinner frame */
  spinnerFrame: number
  /** Number of lines currently rendered */
  renderedLines: number
  /** Start time for elapsed calculation */
  startTime: number
  /** Whether the list has been started */
  started: boolean
  /** Interval handle for spinner */
  intervalHandle: ReturnType<typeof setInterval> | null
}

/** Create initial progress list state */
export const createProgressListState = <T = unknown>(
  items: Array<{ id: string; label: string; data?: T }>,
): ProgressListState<T> => ({
  items: items.map((item) => ({
    ...item,
    status: 'pending' as const,
  })),
  spinnerFrame: 0,
  renderedLines: 0,
  startTime: Date.now(),
  started: false,
  intervalHandle: null,
})

// =============================================================================
// Rendering
// =============================================================================

/** Format a single item line */
const formatItemLine = (item: ProgressItem, spinnerFrame: number): string => {
  switch (item.status) {
    case 'pending':
      return `${styled.dim(symbols.circle)} ${styled.dim(item.label)}`
    case 'active': {
      const spin = styled.cyan(spinner(spinnerFrame))
      const msg = item.message ? styled.dim(` (${item.message})`) : ''
      return `${spin} ${item.label}${msg}`
    }
    case 'success':
      return `${styled.green(symbols.check)} ${item.label}`
    case 'error': {
      const msg = item.message ? styled.dim(` (${item.message})`) : ''
      return `${styled.red(symbols.cross)} ${item.label}${msg}`
    }
  }
}

/** Render the progress list to a string array */
export const renderProgressList = <T>(state: ProgressListState<T>): string[] => {
  return state.items.map((item) => formatItemLine(item, state.spinnerFrame))
}

/** Format the summary line */
export const formatProgressSummary = <T>(state: ProgressListState<T>): string => {
  const completed = state.items.filter(
    (i) => i.status === 'success' || i.status === 'error',
  ).length
  const total = state.items.length
  const errors = state.items.filter((i) => i.status === 'error').length

  const parts: string[] = [`${completed}/${total}`]
  if (errors > 0) {
    parts.push(styled.red(`${errors} error${errors > 1 ? 's' : ''}`))
  }

  return styled.dim(parts.join(' · '))
}

// =============================================================================
// Terminal Output
// =============================================================================

/**
 * Start rendering the progress list.
 * Call this once before any updates.
 */
export const startProgressList = <T>(state: ProgressListState<T>): void => {
  if (!isTTY()) return

  write(hideCursor)
  state.started = true
  state.startTime = Date.now()

  // Initial render
  const lines = renderProgressList(state)
  for (const line of lines) {
    writeLine(line)
  }
  writeLine('') // Summary line placeholder
  writeLine('') // Extra line for spacing
  state.renderedLines = lines.length + 2
}

/**
 * Update the progress list display.
 * Call this after changing item statuses.
 */
export const updateProgressList = <T>(state: ProgressListState<T>): void => {
  if (!isTTY() || !state.started) return

  // Move cursor up to the start of our rendered area
  write(cursorUp(state.renderedLines))

  // Re-render all lines
  const lines = renderProgressList(state)
  for (const line of lines) {
    write(cursorToStart + clearToEOL + line + '\n')
  }

  // Summary line
  write(cursorToStart + clearToEOL + formatProgressSummary(state) + '\n')

  // Extra spacing line
  write(cursorToStart + clearToEOL + '\n')

  state.renderedLines = lines.length + 2
}

/**
 * Finish the progress list rendering.
 * Shows final state and restores cursor.
 */
export const finishProgressList = <T>(
  state: ProgressListState<T>,
  options?: { elapsed?: number },
): void => {
  // Stop spinner interval if running
  if (state.intervalHandle !== null) {
    clearInterval(state.intervalHandle)
    state.intervalHandle = null
  }

  if (!isTTY()) return

  // Final update
  updateProgressList(state)

  // Show cursor again
  write(showCursor)

  state.started = false
}

/**
 * Start the spinner animation.
 * Returns a function to stop the animation.
 */
export const startSpinner = <T>(
  state: ProgressListState<T>,
  interval = 80,
): (() => void) => {
  if (!isTTY()) return () => {}

  state.intervalHandle = setInterval(() => {
    state.spinnerFrame++
    updateProgressList(state)
  }, interval)

  return () => {
    if (state.intervalHandle !== null) {
      clearInterval(state.intervalHandle)
      state.intervalHandle = null
    }
  }
}

// =============================================================================
// State Updates
// =============================================================================

/** Update an item's status */
export const updateItemStatus = <T>(
  state: ProgressListState<T>,
  id: string,
  status: ProgressItemStatus,
  message?: string,
): void => {
  const item = state.items.find((i) => i.id === id)
  if (item) {
    item.status = status
    item.message = message
  }
}

/** Mark an item as active (in progress) */
export const markActive = <T>(
  state: ProgressListState<T>,
  id: string,
  message?: string,
): void => {
  updateItemStatus(state, id, 'active', message)
}

/** Mark an item as success */
export const markSuccess = <T>(state: ProgressListState<T>, id: string): void => {
  updateItemStatus(state, id, 'success')
}

/** Mark an item as error */
export const markError = <T>(
  state: ProgressListState<T>,
  id: string,
  message?: string,
): void => {
  updateItemStatus(state, id, 'error', message)
}

/** Check if all items are completed */
export const isComplete = <T>(state: ProgressListState<T>): boolean => {
  return state.items.every((i) => i.status === 'success' || i.status === 'error')
}

/** Get count of items by status */
export const getStatusCounts = <T>(
  state: ProgressListState<T>,
): Record<ProgressItemStatus, number> => {
  const counts: Record<ProgressItemStatus, number> = {
    pending: 0,
    active: 0,
    success: 0,
    error: 0,
  }
  for (const item of state.items) {
    counts[item.status]++
  }
  return counts
}
