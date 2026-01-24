/**
 * Tree Progress Component
 *
 * A component for displaying hierarchical progress lists with live updates.
 * Combines tree rendering with animated spinner progress.
 *
 * @example
 * ```ts
 * const items = [
 *   { id: 'root', parentId: null, label: 'effect-utils' },
 *   { id: 'cli-ui', parentId: 'root', label: 'cli-ui' },
 *   { id: 'utils', parentId: 'root', label: 'utils' },
 * ]
 *
 * const state = createTreeProgressState(items)
 * startTreeProgress(state)
 * markTreeItemActive(state, 'cli-ui', 'fetching...')
 * // ... later
 * markTreeItemSuccess(state, 'cli-ui')
 * finishTreeProgress(state)
 * ```
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
import { buildTree, flattenTree, treeChars, type FlatTreeItem } from './tree.ts'

// =============================================================================
// Types
// =============================================================================

/** Status of an item in the tree progress */
export type TreeProgressStatus = 'pending' | 'active' | 'success' | 'error' | 'skipped'

/** An item in the tree progress list */
export type TreeProgressItem<T = unknown> = {
  /** Unique identifier */
  id: string
  /** Parent item id (null for root level items) */
  parentId: string | null
  /** Display label */
  label: string
  /** Current status */
  status: TreeProgressStatus
  /** Optional message (shown for active/error states) */
  message?: string | undefined
  /** Optional data associated with the item */
  data?: T
}

/** Options for tree progress rendering */
export type TreeProgressOptions = {
  /** Spinner frame interval in ms (default: 80) */
  spinnerInterval?: number
  /** Whether to show the summary line (default: true) */
  showSummary?: boolean
  /** Tree characters to use (default: unicode) */
  chars?: typeof treeChars
}

// =============================================================================
// State
// =============================================================================

/** State for managing a tree progress display */
export type TreeProgressState<T = unknown> = {
  /** All items (flat list with parentId references) */
  items: TreeProgressItem<T>[]
  /** Current spinner frame */
  spinnerFrame: number
  /** Number of lines currently rendered */
  renderedLines: number
  /** Start time for elapsed calculation */
  startTime: number
  /** Whether the progress has been started */
  started: boolean
  /** Interval handle for spinner */
  intervalHandle: ReturnType<typeof setInterval> | null
  /** Options */
  options: TreeProgressOptions
}

/** Create initial tree progress state */
export const createTreeProgressState = <T = unknown>({
  items,
  options = {},
}: {
  items: Array<{
    id: string
    parentId: string | null
    label: string
    data?: T
  }>
  options?: TreeProgressOptions
}): TreeProgressState<T> => ({
  items: items.map((item) => ({
    ...item,
    status: 'pending' as const,
  })),
  spinnerFrame: 0,
  renderedLines: 0,
  startTime: Date.now(),
  started: false,
  intervalHandle: null,
  options: {
    spinnerInterval: options.spinnerInterval ?? 80,
    showSummary: options.showSummary ?? true,
    chars: options.chars ?? treeChars,
  },
})

// =============================================================================
// Rendering
// =============================================================================

/** Format status icon for an item */
const formatStatusIcon = ({
  status,
  spinnerFrame,
}: {
  status: TreeProgressStatus
  spinnerFrame: number
}): string => {
  switch (status) {
    case 'pending':
      return styled.dim(symbols.circle)
    case 'active':
      return styled.cyan(spinner(spinnerFrame))
    case 'success':
      return styled.green(symbols.check)
    case 'error':
      return styled.red(symbols.cross)
    case 'skipped':
      return styled.dim(symbols.separator)
  }
}

/** Format a single tree item line */
const formatTreeItemLine = ({
  flat,
  spinnerFrame,
}: {
  flat: FlatTreeItem<TreeProgressItem>
  spinnerFrame: number
}): string => {
  const { data: item, prefix } = flat
  const icon = formatStatusIcon({ status: item.status, spinnerFrame })

  // Build the label with appropriate styling
  let label: string
  switch (item.status) {
    case 'pending':
    case 'skipped':
      label = styled.dim(item.label)
      break
    case 'active':
    case 'success':
    case 'error':
      label = item.label
      break
  }

  // Add message if present
  const msg = item.message ? styled.dim(` ${item.message}`) : ''

  // For root items (no prefix), just show icon + label
  if (flat.depth === 0 && prefix === '') {
    return `${icon} ${label}${msg}`
  }

  // For nested items, show prefix + icon + label
  return `${styled.dim(prefix)}${icon} ${label}${msg}`
}

/** Build flattened tree from items */
const buildFlatTree = <T>(state: TreeProgressState<T>): FlatTreeItem<TreeProgressItem<T>>[] => {
  const tree = buildTree({
    items: state.items,
    getId: (item) => item.id,
    getParentId: (item) => item.parentId,
  })

  return flattenTree(
    state.options.chars ? { nodes: tree, chars: state.options.chars } : { nodes: tree },
  )
}

/** Render the tree progress to a string array */
export const renderTreeProgress = <T>(state: TreeProgressState<T>): string[] => {
  const flat = buildFlatTree(state)
  return flat.map((item) => formatTreeItemLine({ flat: item, spinnerFrame: state.spinnerFrame }))
}

/** Format the summary line */
export const formatTreeProgressSummary = <T>(state: TreeProgressState<T>): string => {
  const completed = state.items.filter(
    (i) => i.status === 'success' || i.status === 'error' || i.status === 'skipped',
  ).length
  const total = state.items.length
  const errors = state.items.filter((i) => i.status === 'error').length

  const parts: string[] = [`${completed}/${total}`]
  if (errors > 0) {
    parts.push(styled.red(`${errors} error${errors > 1 ? 's' : ''}`))
  }

  return styled.dim(parts.join(' \u00b7 '))
}

// =============================================================================
// Terminal Output
// =============================================================================

/**
 * Start rendering the tree progress.
 * Call this once before any updates.
 */
export const startTreeProgress = <T>(state: TreeProgressState<T>): void => {
  if (!isTTY()) return

  write(hideCursor)
  state.started = true
  state.startTime = Date.now()

  // Initial render
  const lines = renderTreeProgress(state)
  for (const line of lines) {
    writeLine(line)
  }

  if (state.options.showSummary) {
    writeLine('') // Summary line placeholder
    writeLine('') // Extra line for spacing
    state.renderedLines = lines.length + 2
  } else {
    state.renderedLines = lines.length
  }
}

/**
 * Update the tree progress display.
 * Call this after changing item statuses or adding items.
 */
export const updateTreeProgress = <T>(state: TreeProgressState<T>): void => {
  if (!isTTY() || !state.started) return

  // Move cursor up to the start of our rendered area
  write(cursorUp(state.renderedLines))

  // Re-render all lines
  const lines = renderTreeProgress(state)
  for (const line of lines) {
    write(cursorToStart + clearToEOL + line + '\n')
  }

  if (state.options.showSummary) {
    // Summary line
    write(cursorToStart + clearToEOL + formatTreeProgressSummary(state) + '\n')
    // Extra spacing line
    write(cursorToStart + clearToEOL + '\n')
    state.renderedLines = lines.length + 2
  } else {
    state.renderedLines = lines.length
  }
}

/**
 * Finish the tree progress rendering.
 * Shows final state and restores cursor.
 */
export const finishTreeProgress = <T>(state: TreeProgressState<T>): void => {
  // Stop spinner interval if running
  if (state.intervalHandle !== null) {
    clearInterval(state.intervalHandle)
    state.intervalHandle = null
  }

  if (!isTTY()) return

  // Final update
  updateTreeProgress(state)

  // Show cursor again
  write(showCursor)

  state.started = false
}

/**
 * Start the spinner animation.
 * Returns a function to stop the animation.
 */
export const startTreeSpinner = <T>({
  state,
  interval,
}: {
  state: TreeProgressState<T>
  interval?: number
}): (() => void) => {
  if (!isTTY()) return () => {}

  const spinnerInterval = interval ?? state.options.spinnerInterval ?? 80

  state.intervalHandle = setInterval(() => {
    state.spinnerFrame++
    updateTreeProgress(state)
  }, spinnerInterval)

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

/** Find an item by id */
const findItem = <T>({
  state,
  id,
}: {
  state: TreeProgressState<T>
  id: string
}): TreeProgressItem<T> | undefined => {
  return state.items.find((i) => i.id === id)
}

/** Update an item's status */
export const updateTreeItemStatus = <T>({
  state,
  id,
  status,
  message,
}: {
  state: TreeProgressState<T>
  id: string
  status: TreeProgressStatus
  message?: string
}): void => {
  const item = findItem({ state, id })
  if (item) {
    item.status = status
    item.message = message
  }
}

/** Mark an item as active (in progress) */
export const markTreeItemActive = <T>({
  state,
  id,
  message,
}: {
  state: TreeProgressState<T>
  id: string
  message?: string
}): void => {
  updateTreeItemStatus({ state, id, status: 'active', ...(message !== undefined && { message }) })
}

/** Mark an item as success */
export const markTreeItemSuccess = <T>({
  state,
  id,
  message,
}: {
  state: TreeProgressState<T>
  id: string
  message?: string
}): void => {
  updateTreeItemStatus({ state, id, status: 'success', ...(message !== undefined && { message }) })
}

/** Mark an item as error */
export const markTreeItemError = <T>({
  state,
  id,
  message,
}: {
  state: TreeProgressState<T>
  id: string
  message?: string
}): void => {
  updateTreeItemStatus({ state, id, status: 'error', ...(message !== undefined && { message }) })
}

/** Mark an item as skipped */
export const markTreeItemSkipped = <T>({
  state,
  id,
  message,
}: {
  state: TreeProgressState<T>
  id: string
  message?: string
}): void => {
  updateTreeItemStatus({ state, id, status: 'skipped', ...(message !== undefined && { message }) })
}

/**
 * Add a new item to the tree progress.
 * Useful for dynamically discovered nested items.
 */
export const addTreeItem = <T>({
  state,
  item,
}: {
  state: TreeProgressState<T>
  item: { id: string; parentId: string | null; label: string; data?: T }
}): void => {
  // Check if item already exists
  if (findItem({ state, id: item.id })) {
    return
  }

  state.items.push({
    ...item,
    status: 'pending',
  })
}

/**
 * Remove an item from the tree progress.
 */
export const removeTreeItem = <T>({
  state,
  id,
}: {
  state: TreeProgressState<T>
  id: string
}): void => {
  const index = state.items.findIndex((i) => i.id === id)
  if (index !== -1) {
    state.items.splice(index, 1)
  }
}

// =============================================================================
// Status Queries
// =============================================================================

/** Check if all items are completed */
export const isTreeComplete = <T>(state: TreeProgressState<T>): boolean => {
  return state.items.every(
    (i) => i.status === 'success' || i.status === 'error' || i.status === 'skipped',
  )
}

/** Get count of items by status */
export const getTreeStatusCounts = <T>(
  state: TreeProgressState<T>,
): Record<TreeProgressStatus, number> => {
  const counts: Record<TreeProgressStatus, number> = {
    pending: 0,
    active: 0,
    success: 0,
    error: 0,
    skipped: 0,
  }
  for (const item of state.items) {
    counts[item.status]++
  }
  return counts
}

/** Get elapsed time in milliseconds */
export const getTreeElapsed = <T>(state: TreeProgressState<T>): number => {
  return Date.now() - state.startTime
}

/** Get items with a specific status */
export const getTreeItemsByStatus = <T>({
  state,
  status,
}: {
  state: TreeProgressState<T>
  status: TreeProgressStatus
}): TreeProgressItem<T>[] => {
  return state.items.filter((i) => i.status === status)
}

/** Get child items of a parent */
export const getTreeChildren = <T>({
  state,
  parentId,
}: {
  state: TreeProgressState<T>
  parentId: string | null
}): TreeProgressItem<T>[] => {
  return state.items.filter((i) => i.parentId === parentId)
}
