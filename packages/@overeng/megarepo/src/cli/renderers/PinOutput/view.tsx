/**
 * PinOutput View
 */

import type { Atom } from '@effect-atom/atom'
import React from 'react'

import { Box, Text, useTuiAtomValue, useSymbols } from '@overeng/tui-react'

import type { PinState } from './schema.ts'

/** Props for the PinView component that renders pin/unpin command results. */
export interface PinViewProps {
  stateAtom: Atom.Atom<PinState>
}

/**
 * PinView - View for pin/unpin commands.
 */
export const PinView = ({ stateAtom }: PinViewProps) => {
  const state = useTuiAtomValue(stateAtom)
  const symbols = useSymbols()

  switch (state._tag) {
    case 'Idle':
      return null

    case 'Checking':
      return (
        <Text dim>
          Checking <Text bold>{state.member}</Text>...
        </Text>
      )

    case 'Success':
      if (state.action === 'unpin') {
        return (
          <Box flexDirection="row">
            <Text color="green">{symbols.status.check}</Text>
            <Text> Unpinned </Text>
            <Text bold>{state.member}</Text>
          </Box>
        )
      }
      return (
        <Box flexDirection="row">
          <Text color="green">{symbols.status.check}</Text>
          <Text> Pinned </Text>
          <Text bold>{state.member}</Text>
          {state.ref !== undefined && (
            <>
              <Text> to </Text>
              <Text color="cyan">{state.ref}</Text>
            </>
          )}
          {state.commit !== undefined && (
            <>
              <Text> at </Text>
              <Text dim>{state.commit.slice(0, 7)}</Text>
            </>
          )}
        </Box>
      )

    case 'Already':
      return (
        <Text dim>
          Member '{state.member}' is {state.action === 'pin' ? 'already pinned' : 'not pinned'}
          {state.commit !== undefined && ` at ${state.commit.slice(0, 7)}`}
        </Text>
      )

    case 'DryRun':
      return (
        <Box>
          <Box flexDirection="row">
            <Text>Would {state.action} </Text>
            <Text bold>{state.member}</Text>
            {state.ref !== undefined && (
              <>
                <Text> to </Text>
                <Text color="cyan">{state.ref}</Text>
              </>
            )}
            {state.commit !== undefined && (
              <>
                <Text> at </Text>
                <Text dim>{state.commit.slice(0, 7)}</Text>
              </>
            )}
          </Box>
          <Text> </Text>

          {/* Source change */}
          {state.currentSource !== undefined &&
            state.newSource !== undefined &&
            state.currentSource !== state.newSource && (
              <Box flexDirection="row">
                <Text dim>{'  megarepo.json  '}</Text>
                <Text>{state.currentSource}</Text>
                <Text dim> {symbols.arrows.right} </Text>
                <Text>{state.newSource}</Text>
              </Box>
            )}

          {/* Symlink change */}
          {state.currentSymlink &&
            state.newSymlink &&
            state.currentSymlink !== state.newSymlink && (
              <Box flexDirection="row">
                <Text dim>{'  symlink        '}</Text>
                <Text>{state.currentSymlink}</Text>
                <Text dim> {symbols.arrows.right} </Text>
                <Text>{state.newSymlink}</Text>
              </Box>
            )}

          {/* Lock changes */}
          {state.lockChanges !== undefined && state.lockChanges.length > 0 && (
            <Box flexDirection="row">
              <Text dim>{'  lock           '}</Text>
              <Text>{state.lockChanges.join(', ')}</Text>
            </Box>
          )}

          {/* Additional actions */}
          {(state.wouldClone || state.wouldCreateWorktree || state.worktreeNotAvailable) && (
            <Text> </Text>
          )}
          {state.wouldClone && <Text dim>{'  + would clone bare repo'}</Text>}
          {state.wouldCreateWorktree && <Text dim>{'  + would create worktree'}</Text>}
          {state.worktreeNotAvailable !== undefined && (
            <Box flexDirection="row">
              <Text color="yellow">{'  ! commit worktree not available (repo not in store)'}</Text>
            </Box>
          )}

          <Text> </Text>
          <Text dim>No changes made (dry run)</Text>
        </Box>
      )

    case 'Warning': {
      const getWarningMessage = () => {
        switch (state.warning) {
          case 'worktree_not_available':
            return "Commit worktree not available (repo not in store). Run 'mr sync' to complete."
          case 'member_removed_from_config':
            return `Member '${state.member}' was removed from config but still in lock file`
        }
      }

      return (
        <Box>
          <Box flexDirection="row">
            <Text color="yellow">{symbols.status.warning}</Text>
            <Text color="yellow"> {state.message ?? getWarningMessage()}</Text>
          </Box>
          {state.warning === 'member_removed_from_config' && (
            <Text dim>{'  Consider running: mr sync --pull'}</Text>
          )}
        </Box>
      )
    }

    case 'Error': {
      // Dim messages (informational, not errors)
      if (state.error === 'not_in_lock') {
        return <Text dim>{state.message}</Text>
      }

      return (
        <Box>
          <Box flexDirection="row">
            <Text color="red">{symbols.status.cross}</Text>
            <Text> {state.message}</Text>
          </Box>
          {state.error === 'not_synced' && <Text dim>{'  Run: mr sync'}</Text>}
        </Box>
      )
    }
  }
}
