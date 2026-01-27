/**
 * TaskList component - displays a list of tasks with status indicators.
 *
 * @example
 * ```tsx
 * <TaskList
 *   items={[
 *     { id: 'task1', label: 'Install deps', status: 'success' },
 *     { id: 'task2', label: 'Build', status: 'active', message: 'compiling...' },
 *     { id: 'task3', label: 'Test', status: 'pending' },
 *   ]}
 * />
 * ```
 */

import type { ReactNode } from 'react'
import { Box } from './Box.tsx'
import { Text } from './Text.tsx'
import { Spinner } from './Spinner.tsx'

// =============================================================================
// Types
// =============================================================================

/** Status of a task item */
export type TaskStatus = 'pending' | 'active' | 'success' | 'error' | 'skipped'

/** A single task item */
export interface TaskItem {
  /** Unique identifier */
  readonly id: string
  /** Display label */
  readonly label: string
  /** Current status */
  readonly status: TaskStatus
  /** Optional status message */
  readonly message?: string | undefined
}

/** Props for TaskList component */
export interface TaskListProps {
  /** Items to display */
  readonly items: readonly TaskItem[]
  /** Whether to show a summary line (default: false) */
  readonly showSummary?: boolean | undefined
  /** Optional title to show above the list */
  readonly title?: string | undefined
  /** Optional elapsed time in ms to show in summary */
  readonly elapsed?: number | undefined
}

// =============================================================================
// Status Icons
// =============================================================================

const StatusIcon = ({ status }: { status: TaskStatus }): ReactNode => {
  switch (status) {
    case 'pending':
      return <Text dim>○</Text>
    case 'active':
      return <Spinner />
    case 'success':
      return <Text color="green">✓</Text>
    case 'error':
      return <Text color="red">✗</Text>
    case 'skipped':
      return <Text dim>-</Text>
  }
}

// =============================================================================
// Task Line
// =============================================================================

const TaskLine = ({ item }: { item: TaskItem }): ReactNode => {
  const isDim = item.status === 'pending' || item.status === 'skipped'

  return (
    <Box flexDirection="row">
      <StatusIcon status={item.status} />
      <Text dim={isDim}> {item.label}</Text>
      {item.message && (
        <Text dim> {item.message}</Text>
      )}
    </Box>
  )
}

// =============================================================================
// Summary
// =============================================================================

const formatElapsed = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.floor(seconds % 60)
  return `${minutes}m${remainingSeconds}s`
}

const Summary = ({ items, elapsed }: { items: readonly TaskItem[]; elapsed?: number }): ReactNode => {
  const counts = { pending: 0, active: 0, success: 0, error: 0, skipped: 0 }
  for (const item of items) {
    counts[item.status]++
  }

  const total = items.length
  const completed = counts.success + counts.error + counts.skipped

  const parts: string[] = [`${completed}/${total}`]
  if (counts.error > 0) {
    parts.push(`${counts.error} error${counts.error > 1 ? 's' : ''}`)
  }
  if (elapsed !== undefined) {
    parts.push(formatElapsed(elapsed))
  }

  return (
    <Box paddingTop={1}>
      <Text dim>{parts.join(' · ')}</Text>
    </Box>
  )
}

// =============================================================================
// TaskList Component
// =============================================================================

/**
 * TaskList component - displays a list of tasks with status icons.
 *
 * Status icons:
 * - pending: ○ (dim)
 * - active: spinner
 * - success: ✓ (green)
 * - error: ✗ (red)
 * - skipped: - (dim)
 */
export const TaskList = (props: TaskListProps): ReactNode => {
  const { items, showSummary = false, title, elapsed } = props

  return (
    <Box>
      {title && (
        <Text bold>{title}</Text>
      )}
      <Box>
        {items.map((item) => (
          <TaskLine key={item.id} item={item} />
        ))}
      </Box>
      {showSummary && <Summary items={items} {...(elapsed !== undefined ? { elapsed } : {})} />}
    </Box>
  )
}
