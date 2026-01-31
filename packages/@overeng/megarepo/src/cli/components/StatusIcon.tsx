/**
 * StatusIcon Component
 *
 * Renders status indicators: spinners, checkmarks, crosses, etc.
 */

import React from 'react'

import { Text, Spinner } from '@overeng/tui-react'

import {
  type TaskStatus,
  type SyncResultStatus,
  taskStatusConfig,
  syncStatusConfig,
} from './tokens.ts'

// =============================================================================
// Types
// =============================================================================

export type StatusIconProps =
  | { status: TaskStatus; variant?: 'task' }
  | { status: SyncResultStatus; variant: 'sync' }

// =============================================================================
// Component
// =============================================================================

/**
 * StatusIcon - Universal status indicator
 *
 * Renders the appropriate icon for any status:
 * - Animated spinner for active/syncing states
 * - Colored checkmarks for success states
 * - Colored crosses for error states
 * - Dim circles for pending/skipped states
 *
 * @example
 * ```tsx
 * <StatusIcon status="active" />           // Spinning dots
 * <StatusIcon status="success" />          // Green ✓
 * <StatusIcon status="error" />            // Red ✗
 * <StatusIcon status="cloned" variant="sync" />  // Green ✓
 * ```
 */
export const StatusIcon = (props: StatusIconProps) => {
  const variant = 'variant' in props ? props.variant : 'task'
  const config =
    variant === 'sync'
      ? syncStatusConfig[props.status as SyncResultStatus]
      : taskStatusConfig[props.status as TaskStatus]

  // Render spinner for active states
  if (config.icon === 'spinner') {
    return <Spinner type="dots" color={config.color} />
  }

  // Render static icon
  return (
    <Text color={config.color} dim={config.dim}>
      {config.icon}
    </Text>
  )
}
