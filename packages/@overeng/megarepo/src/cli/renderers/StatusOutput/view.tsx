/**
 * StatusOutput View
 *
 * React component for rendering status output.
 * Supports nested megarepo tree display with inline member warnings.
 *
 * Uses megarepo's design system components for consistent styling.
 */

import type { Atom } from '@effect-atom/atom'
import React from 'react'

import { Box, Text, useTuiAtomValue, unicodeSymbols } from '@overeng/tui-react'

import { MemberRow, ScopeProvider, WorkspaceRootLabel } from '../../components/mod.ts'
import type { StatusState, MemberStatus, LockStaleness, GitStatus, SymlinkDrift } from './schema.ts'

// =============================================================================
// Re-export types for convenience
// =============================================================================

export type { GitStatus, SymlinkDrift, MemberStatus, LockStaleness }

// =============================================================================
// Types
// =============================================================================

/** Props for the StatusView component that renders workspace status with member tree and warnings. */
export interface StatusViewProps {
  stateAtom: Atom.Atom<StatusState>
}

// =============================================================================
// Main Components
// =============================================================================

/**
 * StatusView - View for status command.
 *
 * Renders workspace status including:
 * - Workspace header
 * - Warnings section (problems detected)
 * - Member tree with status indicators
 * - Summary line and legend
 */
export const StatusView = ({ stateAtom }: StatusViewProps) => {
  const state = useTuiAtomValue(stateAtom)
  const { root, members, all, lastSyncTime, lockStaleness, currentMemberPath } = state
  const problems = analyzeProblems({ members, lockStaleness })
  const hasNestedMegarepos = members.some((m) => m.isMegarepo)

  return (
    <Box>
      <WorkspaceRootLabel storePath={root} />
      <WorkspaceWarnings problems={problems} />

      {/* Members — tree rooted at workspace */}
      <MembersTree members={members} prefix="" currentPath={currentMemberPath} />

      {/* Hint for nested megarepos */}
      {!all && hasNestedMegarepos && (
        <NestedMegareposHint count={members.filter((m) => m.isMegarepo).length} />
      )}

      {/* Summary */}
      <Text> </Text>
      <StatusSummary members={members} lastSyncTime={lastSyncTime} />
      <Legend members={members} />
    </Box>
  )
}

// =============================================================================
// Internal Components - Nested Megarepos Hint
// =============================================================================

const NestedMegareposHint = ({ count }: { count: number }) => {
  return (
    <Box paddingTop={1}>
      <Text dim>
        Note: {count} member{count > 1 ? 's' : ''} {count > 1 ? 'are' : 'is a'} nested megarepo
        {count > 1 ? 's' : ''}.
      </Text>
      <Text dim> Run 'mr status --all' to see their members.</Text>
    </Box>
  )
}

// =============================================================================
// Internal Types
// =============================================================================

type Problem =
  | { _tag: 'not_synced'; members: MemberStatus[] }
  | { _tag: 'dirty'; members: MemberStatus[] }
  | { _tag: 'unpushed'; members: MemberStatus[] }
  | { _tag: 'lock_missing' }
  | { _tag: 'lock_stale'; missingFromLock: readonly string[]; extraInLock: readonly string[] }
  | { _tag: 'stale_lock'; members: MemberStatus[] }
  | { _tag: 'symlink_drift'; members: MemberStatus[] }
  | { _tag: 'ref_mismatch'; members: MemberStatus[] }

/** Legend item type with key */
type LegendItem = {
  key: string
  element: React.ReactNode
}

// =============================================================================
// Symbols (from centralized definitions)
// =============================================================================

const symbols = {
  check: unicodeSymbols.status.check,
  cross: unicodeSymbols.status.cross,
  circle: unicodeSymbols.status.circle,
  dot: unicodeSymbols.status.dot,
  dirty: unicodeSymbols.status.dirty,
  ahead: unicodeSymbols.arrows.up,
}

/** Tree branch characters */
const tree = {
  middle: unicodeSymbols.tree.branch,
  last: unicodeSymbols.tree.last,
  vertical: unicodeSymbols.tree.vertical,
  empty: unicodeSymbols.tree.empty,
}

// =============================================================================
// Internal Helper Functions
// =============================================================================

const flattenMembers = (members: readonly MemberStatus[]): MemberStatus[] => {
  const result: MemberStatus[] = []
  for (const member of members) {
    result.push(member)
    if (member.nestedMembers !== undefined) {
      result.push(...flattenMembers(member.nestedMembers))
    }
  }
  return result
}

const analyzeProblems = ({
  members,
  lockStaleness,
}: {
  members: readonly MemberStatus[]
  lockStaleness: LockStaleness | undefined
}): Problem[] => {
  const warnings: Problem[] = []
  const allMembers = flattenMembers(members)

  // Ref mismatch is a critical issue - show first (Issue #88)
  const refMismatched = allMembers.filter((m) => m.refMismatch !== undefined)
  if (refMismatched.length > 0) {
    warnings.push({ _tag: 'ref_mismatch', members: refMismatched })
  }

  // Stale lock: lock ref outdated but current state matches source intent
  const staleLocked = allMembers.filter((m) => m.staleLock !== undefined)
  if (staleLocked.length > 0) {
    warnings.push({ _tag: 'stale_lock', members: staleLocked })
  }

  // Symlink drift: symlink/lock don't match source intent
  const drifted = allMembers.filter((m) => m.symlinkDrift !== undefined)
  if (drifted.length > 0) {
    warnings.push({ _tag: 'symlink_drift', members: drifted })
  }

  if (lockStaleness !== undefined) {
    if (lockStaleness.exists === false) {
      const hasRemoteMembers = allMembers.some((m) => !m.isLocal)
      if (hasRemoteMembers === true) {
        warnings.push({ _tag: 'lock_missing' })
      }
    } else if (lockStaleness.missingFromLock.length > 0 || lockStaleness.extraInLock.length > 0) {
      warnings.push({
        _tag: 'lock_stale',
        missingFromLock: lockStaleness.missingFromLock,
        extraInLock: lockStaleness.extraInLock,
      })
    }
  }

  const notSynced = allMembers.filter((m) => !m.exists)
  if (notSynced.length > 0) {
    warnings.push({ _tag: 'not_synced', members: notSynced })
  }

  const dirty = allMembers.filter((m) => m.gitStatus?.isDirty)
  if (dirty.length > 0) {
    warnings.push({ _tag: 'dirty', members: dirty })
  }

  const unpushed = allMembers.filter((m) => m.gitStatus?.hasUnpushed)
  if (unpushed.length > 0) {
    warnings.push({ _tag: 'unpushed', members: unpushed })
  }

  return warnings
}

/** Count members at different levels */
const countMembers = (members: readonly MemberStatus[]) => {
  const direct = members.length
  let nested = 0
  let synced = 0

  const countRecursive = ({
    ms,
    isNested,
  }: {
    ms: readonly MemberStatus[]
    isNested: boolean
  }): void => {
    for (const m of ms) {
      if (isNested === true) nested++
      if (m.exists === true) synced++
      if (m.nestedMembers !== undefined) {
        countRecursive({ ms: m.nestedMembers, isNested: true })
      }
    }
  }

  for (const m of members) {
    if (m.exists === true) synced++
    if (m.nestedMembers !== undefined) {
      countRecursive({ ms: m.nestedMembers, isNested: true })
    }
  }

  return { direct, nested, synced, total: direct + nested }
}

/** Format relative time */
const formatRelativeTime = (date: Date): string => {
  const now = Date.now()
  const diff = now - date.getTime()
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return `${days}d ago`
  if (hours > 0) return `${hours}h ago`
  if (minutes > 0) return `${minutes}m ago`
  return 'just now'
}

/** Detect which symbols are used for legend */
const detectUsedSymbols = (members: readonly MemberStatus[]) => {
  const allMembers = flattenMembers(members)
  return {
    hasDirty: allMembers.some((m) => m.gitStatus?.isDirty),
    hasUnpushed: allMembers.some((m) => m.gitStatus?.hasUnpushed),
    hasPinned: allMembers.some((m) => m.lockInfo?.pinned),
    hasNotSynced: allMembers.some((m) => !m.exists),
  }
}

// =============================================================================
// Internal Components - Warnings
// =============================================================================

/** Workspace-level warnings (lock_missing, lock_stale) rendered as compact banners */
const WorkspaceWarnings = ({ problems }: { problems: Problem[] }) => {
  const workspaceProblems = problems.filter(
    (p) => p._tag === 'lock_missing' || p._tag === 'lock_stale',
  )
  if (workspaceProblems.length === 0) return null
  return (
    <>
      {workspaceProblems.map((problem) => {
        switch (problem._tag) {
          case 'lock_missing':
            return (
              <Box key="lock_missing" flexDirection="row">
                <Text color="yellow">⚠ lock file missing</Text>
                <Text dim> — fix: mr lock</Text>
              </Box>
            )
          case 'lock_stale':
            return (
              <Box key="lock_stale" flexDirection="row">
                <Text color="yellow">⚠ lock file stale</Text>
                <Text dim> — fix: mr lock</Text>
              </Box>
            )
          default:
            return null
        }
      })}
    </>
  )
}

/** Per-member warnings rendered as sub-lines below each member in the tree */
const MemberWarnings = ({ member, prefix }: { member: MemberStatus; prefix: string }) => {
  const warnings: React.ReactNode[] = []

  if (member.exists === false) {
    warnings.push(
      <Box key="not-synced" flexDirection="row">
        <Text dim>{prefix}</Text>
        <Text color="yellow">⚠ not synced</Text>
        <Text dim> — fix: mr apply</Text>
      </Box>,
    )
  }
  if (member.refMismatch !== undefined) {
    const m = member.refMismatch
    const desc = m.isDetached === true ? `detached at ${m.actualRef}` : `HEAD is '${m.actualRef}'`
    warnings.push(
      <Box key="ref-mismatch" flexDirection="row">
        <Text dim>{prefix}</Text>
        <Text color="red">⚠ ref mismatch</Text>
        <Text dim>
          {' '}
          ({desc}, expected '{m.expectedRef}')
        </Text>
      </Box>,
    )
  }
  if (member.staleLock !== undefined) {
    warnings.push(
      <Box key="stale-lock" flexDirection="row">
        <Text dim>{prefix}</Text>
        <Text color="yellow">⚠ stale lock</Text>
        <Text dim>
          {' '}
          (lock: {member.staleLock.lockRef}, actual: {member.staleLock.actualRef})
        </Text>
      </Box>,
    )
  }
  if (member.symlinkDrift !== undefined) {
    warnings.push(
      <Box key="symlink-drift" flexDirection="row">
        <Text dim>{prefix}</Text>
        <Text color="red">⚠ ref drift</Text>
        <Text dim>
          {' '}
          (tracking '{member.symlinkDrift.symlinkRef}', source says '{member.symlinkDrift.sourceRef}
          ')
        </Text>
      </Box>,
    )
  }
  if (member.gitStatus?.isDirty === true) {
    const count = member.gitStatus.changesCount ?? 0
    warnings.push(
      <Box key="dirty" flexDirection="row">
        <Text dim>{prefix}</Text>
        <Text color="yellow">⚠ uncommitted</Text>
        {count > 0 && <Text dim> ({count})</Text>}
      </Box>,
    )
  }
  if (member.gitStatus?.hasUnpushed === true) {
    warnings.push(
      <Box key="unpushed" flexDirection="row">
        <Text dim>{prefix}</Text>
        <Text color="red">⚠ unpushed</Text>
      </Box>,
    )
  }

  return <>{warnings}</>
}

// =============================================================================
// Internal Components - Member Display
// =============================================================================

/** Member status symbol */
const MemberSymbol = ({ member }: { member: MemberStatus }) => {
  if (member.exists === false) {
    return <Text color="yellow">{symbols.circle}</Text>
  }
  if (member.gitStatus?.isDirty === true) {
    return <Text color="yellow">{symbols.check}</Text>
  }
  return <Text color="green">{symbols.check}</Text>
}

/** Branch display with color coding */
const BranchInfo = ({ member }: { member: MemberStatus }) => {
  if (member.gitStatus?.branch !== undefined && member.gitStatus?.shortRev !== undefined) {
    const branch = member.gitStatus.branch
    const rev = member.gitStatus.shortRev
    const branchColor: 'green' | 'blue' | 'magenta' =
      branch === 'main' || branch === 'master' ? 'green' : branch === 'HEAD' ? 'blue' : 'magenta'
    return (
      <>
        <Text color={branchColor}>{branch}</Text>
        <Text dim>@{rev}</Text>
      </>
    )
  }
  if (member.lockInfo !== undefined) {
    const ref = member.lockInfo.ref
    const refColor: 'green' | 'magenta' = ref === 'main' || ref === 'master' ? 'green' : 'magenta'
    return (
      <>
        <Text color={refColor}>{ref}</Text>
        <Text dim>@{member.lockInfo.commit.slice(0, 7)}</Text>
      </>
    )
  }
  if (member.isLocal === true) {
    return <Text dim>(local)</Text>
  }
  return null
}

/** Single member line — scope dimming is handled by MemberRow via ScopeContext */
const MemberLine = ({ member, prefix = '' }: { member: MemberStatus; prefix?: string }) => (
  <MemberRow prefix={prefix}>
    <MemberSymbol member={member} />
    <Text> </Text>
    <Text bold>{member.name}</Text>
    <Text> </Text>
    <BranchInfo member={member} />
    {member.gitStatus?.isDirty === true && (
      <>
        <Text> </Text>
        <Text color="yellow">{symbols.dirty}</Text>
      </>
    )}
    {member.gitStatus?.hasUnpushed === true && (
      <>
        <Text> </Text>
        <Text color="red">{symbols.ahead}</Text>
      </>
    )}
    {member.lockInfo?.pinned === true && (
      <>
        <Text> </Text>
        <Text color="yellow">pinned</Text>
      </>
    )}
    {member.commitDrift !== undefined && (
      <>
        <Text> </Text>
        <Text dim>({member.commitDrift.localCommit.slice(0, 7)} → lock)</Text>
      </>
    )}
    {member.isMegarepo === true && (
      <>
        <Text> </Text>
        <Text color="cyan">[megarepo]</Text>
      </>
    )}
    {!member.exists && <Text dim> (not synced)</Text>}
  </MemberRow>
)

/** Recursive tree rendering */
const MembersTree = ({
  members,
  prefix,
  currentPath,
}: {
  members: readonly MemberStatus[]
  prefix: string
  currentPath: readonly string[] | undefined
}) => {
  return (
    <>
      {members.map((member, i) => {
        const isLast = i === members.length - 1
        const branchChar = isLast === true ? tree.last : tree.middle
        const isOnCurrentPath = currentPath !== undefined && currentPath[0] === member.name

        return (
          <React.Fragment key={member.name}>
            <ScopeProvider inScope={currentPath === undefined || isOnCurrentPath}>
              <MemberLine member={member} prefix={`${prefix}${branchChar}`} />
              <MemberWarnings
                member={member}
                prefix={prefix + (isLast === true ? tree.empty : tree.vertical)}
              />
            </ScopeProvider>
            {member.isMegarepo === true &&
              member.nestedMembers !== undefined &&
              member.nestedMembers.length > 0 && (
                <MembersTree
                  members={member.nestedMembers}
                  prefix={prefix + (isLast === true ? tree.empty : tree.vertical)}
                  currentPath={
                    isOnCurrentPath === true
                      ? currentPath.length > 1
                        ? currentPath.slice(1)
                        : undefined
                      : undefined
                  }
                />
              )}
          </React.Fragment>
        )
      })}
    </>
  )
}

// =============================================================================
// Internal Components - Summary
// =============================================================================

/** Summary line */
const StatusSummary = ({
  members,
  lastSyncTime,
}: {
  members: readonly MemberStatus[]
  lastSyncTime?: string | undefined
}) => {
  const counts = countMembers(members)
  const parts: string[] = []

  if (counts.nested > 0) {
    parts.push(`${counts.direct} direct`)
    parts.push(`${counts.nested} nested`)
  } else {
    parts.push(`${counts.total} members`)
  }

  if (counts.synced < counts.total) {
    parts.push(`${counts.synced}/${counts.total} synced`)
  }

  if (lastSyncTime !== undefined) {
    const date = new Date(lastSyncTime)
    if (Number.isNaN(date.getTime()) === false) {
      parts.push(`synced ${formatRelativeTime(date)}`)
    }
  }

  return <Text dim>{parts.join(` ${symbols.dot} `)}</Text>
}

/** Legend component */
const Legend = ({ members }: { members: readonly MemberStatus[] }) => {
  const used = detectUsedSymbols(members)
  const items: LegendItem[] = []

  if (used.hasNotSynced === true) {
    items.push({
      key: 'not-synced',
      element: (
        <>
          <Text color="yellow">{symbols.circle}</Text>
          <Text> not synced</Text>
        </>
      ),
    })
  }
  if (used.hasDirty === true) {
    items.push({
      key: 'dirty',
      element: (
        <>
          <Text color="yellow">{symbols.dirty}</Text>
          <Text> uncommitted</Text>
        </>
      ),
    })
  }
  if (used.hasUnpushed === true) {
    items.push({
      key: 'unpushed',
      element: (
        <>
          <Text color="red">{symbols.ahead}</Text>
          <Text> unpushed</Text>
        </>
      ),
    })
  }
  if (used.hasPinned === true) {
    items.push({
      key: 'pinned',
      element: <Text color="yellow">pinned</Text>,
    })
  }

  if (items.length === 0) return null

  return (
    <Box flexDirection="row">
      <Text dim>Legend: </Text>
      {items.map((item, i) => (
        <React.Fragment key={item.key}>
          {i > 0 && <Text>{'  '}</Text>}
          {item.element}
        </React.Fragment>
      ))}
    </Box>
  )
}
