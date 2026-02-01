/**
 * React components for add command output.
 */

import React from 'react'

import { Box, Text } from '@overeng/tui-react'

// =============================================================================
// Types
// =============================================================================

export type AddOutputProps = {
  member: string
  source: string
  synced?: boolean
  syncStatus?: 'cloned' | 'synced' | 'error'
  syncMessage?: string
}

export type AddErrorOutputProps = {
  error: 'not_in_megarepo' | 'invalid_repo' | 'already_exists'
  member?: string
  repo?: string
}

// =============================================================================
// Components
// =============================================================================

/**
 * Success output for add command
 */
export const AddOutput = ({ member, synced, syncStatus, syncMessage }: AddOutputProps) => (
  <Box>
    <Box flexDirection="row">
      <Text color="green">{'\u2713'}</Text>
      <Text> Added </Text>
      <Text bold>{member}</Text>
    </Box>

    {synced && syncStatus && (
      <>
        <Text dim>Syncing...</Text>
        <Box flexDirection="row">
          <Text color={syncStatus === 'error' ? 'red' : 'green'}>
            {syncStatus === 'error' ? '\u2717' : '\u2713'}
          </Text>
          <Text> </Text>
          <Text bold>{member}</Text>
          <Text dim> ({syncStatus === 'cloned' ? 'cloned' : syncStatus})</Text>
          {syncMessage && <Text dim> - {syncMessage}</Text>}
        </Box>
      </>
    )}
  </Box>
)

/**
 * Error output for add command
 */
export const AddErrorOutput = ({ error, member, repo }: AddErrorOutputProps) => {
  const getMessage = () => {
    switch (error) {
      case 'not_in_megarepo':
        return 'Not in a megarepo'
      case 'invalid_repo':
        return `Invalid repo reference: ${repo}`
      case 'already_exists':
        return `Member '${member}' already exists`
    }
  }

  const getHint = () => {
    if (error === 'invalid_repo') {
      return 'Expected: owner/repo, git@host:owner/repo.git, https://host/owner/repo.git, or /path/to/repo'
    }
    return null
  }

  const hint = getHint()

  return (
    <Box>
      <Box flexDirection="row">
        <Text color="red">{'\u2717'}</Text>
        <Text> {getMessage()}</Text>
      </Box>
      {hint && <Text dim>{'  ' + hint}</Text>}
    </Box>
  )
}
