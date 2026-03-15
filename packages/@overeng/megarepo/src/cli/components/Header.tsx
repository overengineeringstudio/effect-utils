/**
 * WorkspaceRootLabel Component
 *
 * Single-line workspace identifier using abbreviated store path (owner/repo@ref).
 */

import React from 'react'

import { Box, Text } from '@overeng/tui-react'

import { abbreviateStorePath } from '../../lib/store-path.ts'

// =============================================================================
// Types
// =============================================================================

/** Props for the WorkspaceRootLabel component. */
export interface WorkspaceRootLabelProps {
  /** Full store path to abbreviate */
  storePath: string
  /** Mode indicators (e.g., "dry run", "force") */
  modes?: readonly string[]
}

// =============================================================================
// Component
// =============================================================================

/**
 * Single-line root label: `owner/repo@ref (modes)`
 */
export const WorkspaceRootLabel = ({ storePath, modes }: WorkspaceRootLabelProps) => (
  <Box flexDirection="row">
    <Text bold>{abbreviateStorePath(storePath)}</Text>
    {modes !== undefined && modes.length > 0 && <Text dim> ({modes.join(', ')})</Text>}
  </Box>
)
