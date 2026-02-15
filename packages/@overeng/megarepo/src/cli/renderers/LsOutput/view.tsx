/**
 * LsOutput View
 *
 * React component for rendering ls output.
 * Handles both success (member list) and error states.
 * Supports hierarchical display when --all is used.
 */

import type { Atom } from '@effect-atom/atom'
import React from 'react'

import { Box, Text, useTuiAtomValue, useSymbols, unicodeSymbols } from '@overeng/tui-react'

import type { LsState, MemberInfo } from './schema.ts'

// =============================================================================
// Tree Symbols
// =============================================================================

const tree = {
  middle: unicodeSymbols.tree.branch,
  last: unicodeSymbols.tree.last,
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get the owner path as a string key for grouping.
 * Root -> '', Nested -> 'foo' or 'foo/bar'
 */
const getOwnerKey = (member: MemberInfo): string => {
  if (member.owner._tag === 'Root') {
    return ''
  }
  return member.owner.path.join('/')
}

/**
 * Group members by their owner for hierarchical display.
 * Returns a map from owner path (as string) to members.
 */
const groupByOwner = (members: readonly MemberInfo[]): Map<string, MemberInfo[]> => {
  const groups = new Map<string, MemberInfo[]>()
  for (const member of members) {
    const key = getOwnerKey(member)
    const group = groups.get(key) ?? []
    group.push(member)
    groups.set(key, group)
  }
  return groups
}

// =============================================================================
// Main Component
// =============================================================================

/** Props for the LsView component that renders the member list or error. */
export interface LsViewProps {
  stateAtom: Atom.Atom<LsState>
}

/**
 * LsView - View for ls command.
 *
 * Renders either:
 * - A list of members with their sources (success)
 * - An error message (error)
 *
 * When --all is used, shows hierarchical display grouped by megarepo.
 */
export const LsView = ({ stateAtom }: LsViewProps) => {
  const state = useTuiAtomValue(stateAtom)
  const symbols = useSymbols()

  // Handle error state
  if (state._tag === 'Error') {
    return (
      <Box flexDirection="row">
        <Text color="red">{symbols.status.cross}</Text>
        <Text> {state.message}</Text>
      </Box>
    )
  }

  // Handle success state
  const { members, all, megarepoName } = state

  if (members.length === 0) {
    return <Text dim>No members in megarepo</Text>
  }

  // Simple flat list for non-all mode
  if (all === false) {
    return (
      <Box flexDirection="column">
        {members.map((member, i) => {
          const isLast = i === members.length - 1
          return (
            <Box key={member.name} flexDirection="row">
              <Text dim>{isLast === true ? tree.last : tree.middle}</Text>
              <Text bold>{member.name}</Text>
              <Text dim> ({member.source})</Text>
              {member.isMegarepo !== undefined && (
                <>
                  <Text> </Text>
                  <Text color="cyan">[megarepo]</Text>
                </>
              )}
            </Box>
          )
        })}
      </Box>
    )
  }

  // Hierarchical display for --all mode
  const groups = groupByOwner(members)
  const sortedPaths = Array.from(groups.keys()).toSorted()

  return (
    <Box flexDirection="column">
      {sortedPaths.map((path, pathIndex) => {
        const groupMembers = groups.get(path)!
        const megarepoLabel = path === '' ? megarepoName : path.split('/').pop()!
        const isNested = path !== ''
        const isLastGroup = pathIndex === sortedPaths.length - 1

        return (
          <React.Fragment key={path}>
            {/* Group header */}
            <Box flexDirection="row">
              <Text bold color={isNested === true ? 'cyan' : undefined}>
                {megarepoLabel}
              </Text>
              {isNested && <Text dim> (nested megarepo)</Text>}
            </Box>

            {/* Members in this group */}
            {groupMembers.map((member, i) => {
              const isLast = i === groupMembers.length - 1
              return (
                <Box key={member.name} flexDirection="row">
                  <Text dim>{isLast === true ? tree.last : tree.middle}</Text>
                  <Text bold>{member.name}</Text>
                  <Text dim> ({member.source})</Text>
                  {member.isMegarepo !== undefined && (
                    <>
                      <Text> </Text>
                      <Text color="cyan">[megarepo]</Text>
                    </>
                  )}
                </Box>
              )
            })}

            {/* Spacing between groups */}
            {!isLastGroup && <Text> </Text>}
          </React.Fragment>
        )
      })}
    </Box>
  )
}
