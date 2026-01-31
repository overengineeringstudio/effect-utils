/**
 * TaskItem Component
 *
 * Single task row with status icon, label, and optional message.
 */

import React from 'react'

import { Box, Text } from '@overeng/tui-react'

import { StatusIcon } from './StatusIcon.tsx'
import { type TaskStatus } from './tokens.ts'

// =============================================================================
// Types
// =============================================================================

export interface TaskItemProps {
  /** Unique identifier */
  id: string
  /** Display label */
  label: string
  /** Current status */
  status: TaskStatus
  /** Optional status message */
  message?: string
}

// =============================================================================
// Component
// =============================================================================

/**
 * TaskItem - Single task row
 *
 * Renders a task with icon, label, and optional message:
 * ```
 * ✓ effect-utils  synced (main)
 * ⠋ livestore     syncing...
 * ○ dotfiles
 * ```
 *
 * Pending items have dimmed labels for visual hierarchy.
 *
 * @example
 * ```tsx
 * <TaskItem id="effect" label="effect" status="success" message="synced (main)" />
 * <TaskItem id="live" label="livestore" status="active" message="syncing..." />
 * <TaskItem id="dot" label="dotfiles" status="pending" />
 * ```
 */
export const TaskItem = ({ label, status, message }: TaskItemProps) => {
  const isPendingOrSkipped = status === 'pending' || status === 'skipped'

  return (
    <Box flexDirection="row">
      <StatusIcon status={status} />
      <Text> </Text>
      <Text bold={!isPendingOrSkipped} dim={isPendingOrSkipped}>
        {label}
      </Text>
      {message && (
        <>
          <Text> </Text>
          <Text dim>{message}</Text>
        </>
      )}
    </Box>
  )
}
