/**
 * React components for pin/unpin command output.
 */

import React from 'react'

import { Box, Text } from '@overeng/tui-react'

// =============================================================================
// Types
// =============================================================================

export type PinOutputProps = {
  action: 'pin' | 'unpin'
  member: string
  status: 'success' | 'already_pinned' | 'already_unpinned' | 'dry_run'
  ref?: string
  commit?: string
  /** Dry run details */
  dryRun?: {
    currentSource?: string
    newSource?: string
    currentSymlink?: string
    newSymlink?: string
    lockChanges?: string[]
    wouldClone?: boolean
    wouldCreateWorktree?: boolean
    /** Warning when repo not in store */
    worktreeNotAvailable?: boolean
  }
}

export type PinErrorOutputProps = {
  error:
    | 'not_in_megarepo'
    | 'member_not_found'
    | 'invalid_source'
    | 'local_path'
    | 'not_synced'
    | 'no_lock'
    | 'not_in_lock'
  member?: string
}

export type PinWarningOutputProps = {
  warning: 'worktree_not_available' | 'member_removed_from_config'
  member?: string
  message?: string
}

// =============================================================================
// Components
// =============================================================================

/**
 * Main PinOutput component
 */
export const PinOutput = ({ action, member, status, ref, commit, dryRun }: PinOutputProps) => {
  if (status === 'dry_run' && dryRun) {
    return (
      <DryRunOutput action={action} member={member} ref={ref} commit={commit} dryRun={dryRun} />
    )
  }

  if (status === 'already_pinned') {
    return <AlreadyStatus member={member} status="pinned" commit={commit} />
  }

  if (status === 'already_unpinned') {
    return <AlreadyStatus member={member} status="unpinned" />
  }

  if (action === 'unpin') {
    return <UnpinSuccess member={member} />
  }

  return <PinSuccess member={member} ref={ref} commit={commit} />
}

/**
 * Error output for pin/unpin commands
 */
export const PinErrorOutput = ({ error, member }: PinErrorOutputProps) => {
  const getMessage = () => {
    switch (error) {
      case 'not_in_megarepo':
        return 'Not in a megarepo'
      case 'member_not_found':
        return `Member '${member}' not found`
      case 'invalid_source':
        return 'Invalid source string'
      case 'local_path':
        return 'Cannot pin local path members'
      case 'not_synced':
        return `Member '${member}' not synced yet`
      case 'no_lock':
        return 'No lock file found'
      case 'not_in_lock':
        return `Member '${member}' not in lock file`
    }
  }

  // Dim messages (informational, not errors)
  if (error === 'not_in_lock') {
    return <Text dim>{getMessage()}</Text>
  }

  return (
    <Box>
      <Box flexDirection="row">
        <Text color="red">{'\u2717'}</Text>
        <Text> {getMessage()}</Text>
      </Box>
      {error === 'not_synced' && <Text dim>{'  Run: mr sync'}</Text>}
    </Box>
  )
}

/**
 * Warning output for pin/unpin commands
 */
export const PinWarningOutput = ({ warning, member, message }: PinWarningOutputProps) => {
  const getWarningMessage = () => {
    switch (warning) {
      case 'worktree_not_available':
        return "Commit worktree not available (repo not in store). Run 'mr sync' to complete."
      case 'member_removed_from_config':
        return `Member '${member}' was removed from config but still in lock file`
    }
  }

  return (
    <Box>
      <Box flexDirection="row">
        <Text color="yellow">{'\u26a0'}</Text>
        <Text color="yellow"> {message ?? getWarningMessage()}</Text>
      </Box>
      {warning === 'member_removed_from_config' && (
        <Text dim>{'  Consider running: mr sync --pull'}</Text>
      )}
    </Box>
  )
}

// =============================================================================
// Internal Components
// =============================================================================

/**
 * Success output for pin command
 */
function PinSuccess({
  member,
  ref,
  commit,
}: {
  member: string
  ref?: string | undefined
  commit?: string | undefined
}) {
  return (
    <Box flexDirection="row">
      <Text color="green">{'\u2713'}</Text>
      <Text> Pinned </Text>
      <Text bold>{member}</Text>
      {ref && (
        <>
          <Text> to </Text>
          <Text color="cyan">{ref}</Text>
        </>
      )}
      {commit && (
        <>
          <Text> at </Text>
          <Text dim>{commit.slice(0, 7)}</Text>
        </>
      )}
    </Box>
  )
}

/**
 * Success output for unpin command
 */
function UnpinSuccess({ member }: { member: string }) {
  return (
    <Box flexDirection="row">
      <Text color="green">{'\u2713'}</Text>
      <Text> Unpinned </Text>
      <Text bold>{member}</Text>
    </Box>
  )
}

/**
 * Already pinned/unpinned message
 */
function AlreadyStatus({
  member,
  status,
  commit,
}: {
  member: string
  status: 'pinned' | 'unpinned'
  commit?: string | undefined
}) {
  return (
    <Text dim>
      Member '{member}' is {status === 'pinned' ? 'already pinned' : 'not pinned'}
      {commit && ` at ${commit.slice(0, 7)}`}
    </Text>
  )
}

/**
 * Dry run output
 */
function DryRunOutput({
  action,
  member,
  ref,
  commit,
  dryRun,
}: {
  action: 'pin' | 'unpin'
  member: string
  ref?: string | undefined
  commit?: string | undefined
  dryRun: NonNullable<PinOutputProps['dryRun']>
}) {
  return (
    <Box>
      <Box flexDirection="row">
        <Text>Would {action} </Text>
        <Text bold>{member}</Text>
        {ref && (
          <>
            <Text> to </Text>
            <Text color="cyan">{ref}</Text>
          </>
        )}
        {commit && (
          <>
            <Text> at </Text>
            <Text dim>{commit.slice(0, 7)}</Text>
          </>
        )}
      </Box>
      <Text> </Text>

      {/* Source change */}
      {dryRun.currentSource && dryRun.newSource && dryRun.currentSource !== dryRun.newSource && (
        <Box flexDirection="row">
          <Text dim>{'  megarepo.json  '}</Text>
          <Text>{dryRun.currentSource}</Text>
          <Text dim> {'\u2192'} </Text>
          <Text>{dryRun.newSource}</Text>
        </Box>
      )}

      {/* Symlink change */}
      {dryRun.currentSymlink &&
        dryRun.newSymlink &&
        dryRun.currentSymlink !== dryRun.newSymlink && (
          <Box flexDirection="row">
            <Text dim>{'  symlink        '}</Text>
            <Text>{dryRun.currentSymlink}</Text>
            <Text dim> {'\u2192'} </Text>
            <Text>{dryRun.newSymlink}</Text>
          </Box>
        )}

      {/* Lock changes */}
      {dryRun.lockChanges && dryRun.lockChanges.length > 0 && (
        <Box flexDirection="row">
          <Text dim>{'  lock           '}</Text>
          <Text>{dryRun.lockChanges.join(', ')}</Text>
        </Box>
      )}

      {/* Additional actions */}
      {(dryRun.wouldClone || dryRun.wouldCreateWorktree || dryRun.worktreeNotAvailable) && (
        <Text> </Text>
      )}
      {dryRun.wouldClone && <Text dim>{'  + would clone bare repo'}</Text>}
      {dryRun.wouldCreateWorktree && <Text dim>{'  + would create worktree'}</Text>}
      {dryRun.worktreeNotAvailable && (
        <Box flexDirection="row">
          <Text color="yellow">{'  ! commit worktree not available (repo not in store)'}</Text>
        </Box>
      )}

      <Text> </Text>
      <Text dim>No changes made (dry run)</Text>
    </Box>
  )
}
