/**
 * Header Component
 *
 * Workspace header with name, path, and mode indicators.
 */

import React from 'react'

import { Box, Text } from '@overeng/tui-react'

// =============================================================================
// Types
// =============================================================================

/** Props for the Header component that renders workspace name, path, and mode indicators. */
export interface HeaderProps {
  /** Workspace name (bold) */
  name: string
  /** Workspace root path */
  root?: string
  /** Mode indicators (e.g., "dry run", "frozen", "pull") */
  modes?: readonly string[]
}

// =============================================================================
// Component
// =============================================================================

/**
 * Header - Workspace header
 *
 * Renders workspace info in expanded format:
 * ```
 * mr-workspace
 *   root: /path/to/workspace
 *   mode: dry run
 * ```
 *
 * @example
 * ```tsx
 * <Header name="mr-workspace" root="/path" modes={['dry run']} />
 * ```
 */
export const Header = ({ name, root, modes }: HeaderProps) => (
  <Box flexDirection="column">
    <Text bold>{name}</Text>
    {root && (
      <Box flexDirection="row">
        <Text dim>{'  root: '}</Text>
        <Text>{root}</Text>
      </Box>
    )}
    {modes && modes.length > 0 && (
      <Text dim>
        {'  mode: '}
        {modes.join(', ')}
      </Text>
    )}
  </Box>
)
