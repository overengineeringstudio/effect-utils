/**
 * Shared Error View
 *
 * Common error display components used across CLI commands.
 */

import React from 'react'

import { Box, Text } from '@overeng/tui-react'

// =============================================================================
// Symbols
// =============================================================================

const symbols = {
  cross: '\u2717',
}

// =============================================================================
// Components
// =============================================================================

export interface NotInMegarepoViewProps {
  message?: string
}

/**
 * View for "not in megarepo" error.
 * Used when a command is run outside a megarepo context.
 */
export const NotInMegarepoView = ({ message = 'Not in a megarepo' }: NotInMegarepoViewProps) => (
  <Box flexDirection="row">
    <Text color="red">{symbols.cross}</Text>
    <Text> {message}</Text>
  </Box>
)

export interface NotGitRepoViewProps {
  message?: string
}

/**
 * View for "not a git repo" error.
 * Used when init is run outside a git repository.
 */
export const NotGitRepoView = ({
  message = "Not a git repository. Run 'git init' first.",
}: NotGitRepoViewProps) => (
  <Box flexDirection="row">
    <Text color="red">{symbols.cross}</Text>
    <Text> {message}</Text>
  </Box>
)

export interface GenericErrorViewProps {
  message: string
}

/**
 * Generic error view with a cross symbol.
 */
export const GenericErrorView = ({ message }: GenericErrorViewProps) => (
  <Box flexDirection="row">
    <Text color="red">{symbols.cross}</Text>
    <Text> {message}</Text>
  </Box>
)
