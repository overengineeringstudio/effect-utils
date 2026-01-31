/**
 * LogLine Component
 *
 * Single log entry with type indicator and message.
 */

import React from 'react'

import { Box, Text } from '@overeng/tui-react'

import { type LogType, logConfig } from './tokens.ts'

// =============================================================================
// Types
// =============================================================================

export interface LogLineProps {
  /** Log type */
  type: LogType
  /** Log message */
  message: string
}

// =============================================================================
// Component
// =============================================================================

/**
 * LogLine - Log entry with type indicator
 *
 * Renders log lines with colored prefix:
 * ```
 * [i] Cloning effect from github.com/Effect-TS/effect
 * [!] dotfiles has uncommitted changes
 * [!] network timeout after 30s
 * ```
 *
 * @example
 * ```tsx
 * <LogLine type="info" message="Cloning effect..." />
 * <LogLine type="warn" message="Skipping dirty worktree" />
 * <LogLine type="error" message="Network timeout" />
 * ```
 */
export const LogLine = ({ type, message }: LogLineProps) => {
  const config = logConfig[type]

  return (
    <Box flexDirection="row">
      <Text color={config.color}>[{config.prefix}]</Text>
      <Text dim> {message}</Text>
    </Box>
  )
}
