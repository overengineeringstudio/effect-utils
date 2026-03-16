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

import { MemberRow, ScopeProvider, WorkspaceRootLabel } from '../../components/mod.ts'
import type { LsState, MemberInfo } from './schema.ts'

// =============================================================================
// Types
// =============================================================================

/** Props for the LsView component that renders the member list or error. */
export interface LsViewProps {
  stateAtom: Atom.Atom<LsState>
}

// =============================================================================
// Main Component
// =============================================================================

/**
 * LsView - View for ls command.
 *
 * Renders either:
 * - A list of members with their sources (success)
 * - An error message (error)
 *
 * When --all is used, shows hierarchical display grouped by megarepo.
 * Scope dimming: dims all members except the one the user's cwd is inside.
 * Works in both flat and --all modes, highlighting the current path through the tree.
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
  const { members, all, currentMemberPath, root } = state
  const scopePath = currentMemberPath

  if (members.length === 0) {
    return <Text dim>No members in megarepo</Text>
  }

  // Simple flat list for non-all mode
  if (all === false) {
    return (
      <Box flexDirection="column">
        <WorkspaceRootLabel storePath={root} />
        {members.map((member, i) => {
          const isLast = i === members.length - 1
          const isInScope = scopePath === undefined || scopePath[0] === member.name
          return (
            <ScopeProvider key={member.name} inScope={isInScope}>
              <MemberRow prefix={isLast === true ? tree.last : tree.middle}>
                <Text bold>{member.name}</Text>
                <Text dim> ({member.source})</Text>
                {member.isMegarepo === true && (
                  <>
                    <Text> </Text>
                    <Text color="cyan">[megarepo]</Text>
                  </>
                )}
              </MemberRow>
            </ScopeProvider>
          )
        })}
      </Box>
    )
  }

  // Hierarchical display for --all mode as a single nested tree
  const nodes = buildTree(members)

  return (
    <Box flexDirection="column">
      <WorkspaceRootLabel storePath={root} />
      <MemberTree nodes={nodes} prefix="" currentPath={scopePath} />
    </Box>
  )
}

// =============================================================================
// Internal - Tree Symbols
// =============================================================================

const tree = {
  middle: unicodeSymbols.tree.branch,
  last: unicodeSymbols.tree.last,
  vertical: unicodeSymbols.tree.vertical,
  empty: unicodeSymbols.tree.empty,
}

// =============================================================================
// Internal - Tree Building
// =============================================================================

type TreeNode = {
  member: MemberInfo
  children: TreeNode[]
}

const buildTree = (members: readonly MemberInfo[]): TreeNode[] => {
  const rootMembers = members.filter((m) => m.owner._tag === 'Root')
  const nestedByOwner = new Map<string, MemberInfo[]>()
  for (const m of members) {
    if (m.owner._tag === 'Nested') {
      const ownerName = m.owner.path[m.owner.path.length - 1]!
      const group = nestedByOwner.get(ownerName) ?? []
      group.push(m)
      nestedByOwner.set(ownerName, group)
    }
  }

  const buildNode = (member: MemberInfo): TreeNode => ({
    member,
    children: (nestedByOwner.get(member.name) ?? []).map(buildNode),
  })

  return rootMembers.map(buildNode)
}

// =============================================================================
// Internal - Tree Rendering
// =============================================================================

const MemberTree = ({
  nodes,
  prefix,
  currentPath,
}: {
  nodes: TreeNode[]
  prefix: string
  currentPath: readonly string[] | undefined
}) => (
  <>
    {nodes.map((node, i) => {
      const isLast = i === nodes.length - 1
      const branchChar = isLast === true ? tree.last : tree.middle
      const childPrefix = prefix + (isLast === true ? tree.empty : tree.vertical)
      const isOnCurrentPath = currentPath !== undefined && currentPath[0] === node.member.name
      return (
        <React.Fragment key={node.member.name}>
          <ScopeProvider inScope={currentPath === undefined || isOnCurrentPath}>
            <MemberRow prefix={`${prefix}${branchChar}`}>
              <Text bold>{node.member.name}</Text>
              <Text dim> ({node.member.source})</Text>
              {node.member.isMegarepo === true && (
                <>
                  <Text> </Text>
                  <Text color="cyan">[megarepo]</Text>
                </>
              )}
            </MemberRow>
          </ScopeProvider>
          {node.children.length > 0 && (
            <MemberTree
              nodes={node.children}
              prefix={childPrefix}
              currentPath={
                isOnCurrentPath === true
                  ? currentPath.length > 1
                    ? currentPath.slice(1)
                    : undefined
                  : []
              }
            />
          )}
        </React.Fragment>
      )
    })}
  </>
)
