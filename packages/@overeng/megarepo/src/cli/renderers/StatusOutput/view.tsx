/**
 * StatusOutput View
 *
 * React component for rendering status output.
 * Supports nested megarepo tree display with problem-first badges.
 *
 * Uses megarepo's design system components for consistent styling.
 */

import type { Atom } from '@effect-atom/atom'
import React from 'react'

import { Box, Text, useTuiAtomValue, unicodeSymbols } from '@overeng/tui-react'

import { Separator } from '../../components/mod.ts'
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
  const { name, root, members, all, lastSyncTime, lockStaleness, currentMemberPath } = state
  const problems = analyzeProblems({ members, lockStaleness })
  const hasNesting = members.some((m) => m.nestedMembers && m.nestedMembers.length > 0)
  const hasNestedMegarepos = members.some((m) => m.isMegarepo)

  return (
    <Box>
      {/* Header */}
      <Text bold>{name}</Text>
      <Box flexDirection="row">
        <Text dim>{'  root: '}</Text>
        <Text>{root}</Text>
      </Box>
      <Text> </Text>

      {/* Warnings */}
      <WarningsSection problems={problems} />

      {/* Members */}
      {hasNesting ? (
        // Tree mode (when --all is used and there are nested members)
        <>
          {members.map((member, i) => {
            const isOnCurrentPath =
              currentMemberPath !== undefined && currentMemberPath[0] === member.name
            const isCurrent = isOnCurrentPath && currentMemberPath.length === 1

            return (
              <React.Fragment key={member.name}>
                <MemberLine member={member} isCurrent={isCurrent} />
                {member.isMegarepo && member.nestedMembers && member.nestedMembers.length > 0 && (
                  <MembersTree
                    members={member.nestedMembers}
                    prefix=""
                    currentPath={isOnCurrentPath ? currentMemberPath.slice(1) : undefined}
                  />
                )}
                {i < members.length - 1 && <Text> </Text>}
              </React.Fragment>
            )
          })}
        </>
      ) : (
        // Flat mode
        <>
          {members.map((member) => {
            const isCurrent =
              currentMemberPath !== undefined &&
              currentMemberPath.length === 1 &&
              currentMemberPath[0] === member.name
            return <MemberLine key={member.name} member={member} isCurrent={isCurrent} />
          })}
        </>
      )}

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
    if (member.nestedMembers) {
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

  // Symlink drift is also a critical issue
  const drifted = allMembers.filter((m) => m.symlinkDrift !== undefined)
  if (drifted.length > 0) {
    warnings.push({ _tag: 'symlink_drift', members: drifted })
  }

  if (lockStaleness !== undefined) {
    if (!lockStaleness.exists) {
      const hasRemoteMembers = allMembers.some((m) => !m.isLocal)
      if (hasRemoteMembers) {
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

/** Generate a unique key for a problem based on its tag and content */
const getProblemKey = (problem: Problem): string => {
  switch (problem._tag) {
    case 'not_synced':
      return `not_synced-${problem.members.map((m) => m.name).join(',')}`
    case 'dirty':
      return `dirty-${problem.members.map((m) => m.name).join(',')}`
    case 'unpushed':
      return `unpushed-${problem.members.map((m) => m.name).join(',')}`
    case 'lock_missing':
      return 'lock_missing'
    case 'lock_stale':
      return `lock_stale-${problem.missingFromLock.join(',')}-${problem.extraInLock.join(',')}`
    case 'symlink_drift':
      return `symlink_drift-${problem.members.map((m) => m.name).join(',')}`
    case 'ref_mismatch':
      return `ref_mismatch-${problem.members.map((m) => m.name).join(',')}`
  }
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
      if (isNested) nested++
      if (m.exists) synced++
      if (m.nestedMembers) {
        countRecursive({ ms: m.nestedMembers, isNested: true })
      }
    }
  }

  for (const m of members) {
    if (m.exists) synced++
    if (m.nestedMembers) {
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

/** Warning badge - matches cli-ui badge('WARNING', 'warning') */
const WarningBadge = () => {
  return (
    <Text backgroundColor="yellow" color="black" bold>
      {' WARNING '}
    </Text>
  )
}

/** Single warning item */
const WarningItem = ({ problem }: { problem: Problem }) => {
  switch (problem._tag) {
    case 'ref_mismatch': {
      const count = problem.members.length
      return (
        <Box>
          <Box flexDirection="row">
            <Text>{'  '}</Text>
            <Text bold color="red">
              {count} member{count > 1 ? 's' : ''}
            </Text>
            <Text> </Text>
            <Text dim>git HEAD differs from store path</Text>
          </Box>
          {problem.members.map((m) => {
            const mismatch = m.refMismatch!
            return (
              <Box key={m.name}>
                <Box flexDirection="row">
                  <Text>{'    '}</Text>
                  <Text bold>{m.name}</Text>
                </Box>
                <Box flexDirection="row">
                  <Text>{'      '}</Text>
                  <Text dim>store path: </Text>
                  <Text color="green">{mismatch.expectedRef}</Text>
                </Box>
                <Box flexDirection="row">
                  <Text>{'      '}</Text>
                  <Text dim>git HEAD: </Text>
                  <Text color="yellow">
                    {mismatch.isDetached ? `detached at ${mismatch.actualRef}` : mismatch.actualRef}
                  </Text>
                </Box>
                <Box flexDirection="row">
                  <Text>{'      '}</Text>
                  <Text color="cyan">fix: </Text>
                  <Text>
                    mr pin {m.name} -c {mismatch.actualRef}
                  </Text>
                </Box>
                <Box flexDirection="row">
                  <Text>{'           '}</Text>
                  <Text dim>or: </Text>
                  <Text>git checkout {mismatch.expectedRef}</Text>
                  <Text dim> (in repos/{m.name})</Text>
                </Box>
              </Box>
            )
          })}
        </Box>
      )
    }
    case 'symlink_drift': {
      const count = problem.members.length
      return (
        <Box>
          <Box flexDirection="row">
            <Text>{'  '}</Text>
            <Text bold color="red">
              {count} member{count > 1 ? 's' : ''}
            </Text>
            <Text> </Text>
            <Text dim>symlink points to wrong worktree</Text>
          </Box>
          {problem.members.map((m) => {
            const drift = m.symlinkDrift!
            return (
              <Box key={m.name}>
                <Box flexDirection="row">
                  <Text>{'    '}</Text>
                  <Text bold>{m.name}</Text>
                </Box>
                <Box flexDirection="row">
                  <Text>{'      '}</Text>
                  <Text dim>symlink: </Text>
                  <Text color="yellow">{drift.symlinkRef}</Text>
                </Box>
                <Box flexDirection="row">
                  <Text>{'      '}</Text>
                  <Text dim>expected: </Text>
                  <Text color="green">{drift.expectedRef}</Text>
                  <Text dim> (from lock)</Text>
                </Box>
                {drift.actualGitBranch && drift.actualGitBranch !== drift.symlinkRef && (
                  <Box flexDirection="row">
                    <Text>{'      '}</Text>
                    <Text dim>git branch: </Text>
                    <Text color="magenta">{drift.actualGitBranch}</Text>
                  </Box>
                )}
                <Box flexDirection="row">
                  <Text>{'      '}</Text>
                  <Text color="cyan">fix: </Text>
                  <Text>mr sync --pull --member {m.name}</Text>
                </Box>
              </Box>
            )
          })}
        </Box>
      )
    }
    case 'lock_missing':
      return (
        <Box>
          <Box flexDirection="row">
            <Text>{'  '}</Text>
            <Text bold>Lock file missing</Text>
          </Box>
          <Text dim>{'    Remote members are not tracked in lock file'}</Text>
          <Box flexDirection="row">
            <Text>{'    '}</Text>
            <Text color="cyan">fix:</Text>
            <Text> mr sync</Text>
          </Box>
        </Box>
      )
    case 'lock_stale':
      return (
        <Box>
          <Box flexDirection="row">
            <Text>{'  '}</Text>
            <Text bold>Lock file is stale</Text>
          </Box>
          {problem.missingFromLock.length > 0 && (
            <Box flexDirection="row">
              <Text>{'    '}</Text>
              <Text dim>Not in lock:</Text>
              <Text> {problem.missingFromLock.join(', ')}</Text>
            </Box>
          )}
          {problem.extraInLock.length > 0 && (
            <Box flexDirection="row">
              <Text>{'    '}</Text>
              <Text dim>Removed from config:</Text>
              <Text> {problem.extraInLock.join(', ')}</Text>
            </Box>
          )}
          <Box flexDirection="row">
            <Text>{'    '}</Text>
            <Text color="cyan">fix:</Text>
            <Text> mr sync</Text>
          </Box>
        </Box>
      )
    case 'not_synced': {
      const count = problem.members.length
      const names = problem.members.map((m) => m.name)
      return (
        <Box>
          <Box flexDirection="row">
            <Text>{'  '}</Text>
            <Text bold>
              {count} member{count > 1 ? 's' : ''}
            </Text>
            <Text> </Text>
            <Text dim>not synced</Text>
          </Box>
          <Text dim>{'    ' + names.join(', ')}</Text>
          <Box flexDirection="row">
            <Text>{'    '}</Text>
            <Text color="cyan">fix:</Text>
            <Text> mr sync</Text>
          </Box>
        </Box>
      )
    }
    case 'dirty': {
      const count = problem.members.length
      const names = problem.members.map((m) => {
        const changes = m.gitStatus?.changesCount ?? 0
        return changes > 0 ? `${m.name} (${changes})` : m.name
      })
      return (
        <Box>
          <Box flexDirection="row">
            <Text>{'  '}</Text>
            <Text bold>
              {count} member{count > 1 ? 's' : ''}
            </Text>
            <Text> </Text>
            <Text dim>have uncommitted changes</Text>
          </Box>
          <Text dim>{'    ' + names.join(', ')}</Text>
          <Box flexDirection="row">
            <Text>{'    '}</Text>
            <Text color="cyan">fix:</Text>
            <Text> git status {'<member>'}</Text>
          </Box>
        </Box>
      )
    }
    case 'unpushed': {
      const count = problem.members.length
      const names = problem.members.map((m) => m.name)
      return (
        <Box>
          <Box flexDirection="row">
            <Text>{'  '}</Text>
            <Text bold>
              {count} member{count > 1 ? 's' : ''}
            </Text>
            <Text> </Text>
            <Text dim>have unpushed commits</Text>
          </Box>
          <Text dim>{'    ' + names.join(', ')}</Text>
          <Box flexDirection="row">
            <Text>{'    '}</Text>
            <Text color="cyan">fix:</Text>
            <Text> cd {'<member>'} && git push</Text>
          </Box>
        </Box>
      )
    }
  }
}

/** Warnings section */
const WarningsSection = ({ problems }: { problems: Problem[] }) => {
  if (problems.length === 0) return null
  return (
    <Box>
      <WarningBadge />
      <Text> </Text>
      {problems.map((problem) => (
        <Box key={getProblemKey(problem)}>
          <WarningItem problem={problem} />
          <Text> </Text>
        </Box>
      ))}
      <Separator />
      <Text> </Text>
    </Box>
  )
}

// =============================================================================
// Internal Components - Member Display
// =============================================================================

/** Member status symbol */
const MemberSymbol = ({ member }: { member: MemberStatus }) => {
  if (!member.exists) {
    return <Text color="yellow">{symbols.circle}</Text>
  }
  if (member.gitStatus?.isDirty) {
    return <Text color="yellow">{symbols.check}</Text>
  }
  return <Text color="green">{symbols.check}</Text>
}

/** Branch display with color coding */
const BranchInfo = ({ member }: { member: MemberStatus }) => {
  if (member.gitStatus?.branch && member.gitStatus?.shortRev) {
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
  if (member.lockInfo) {
    const ref = member.lockInfo.ref
    const refColor: 'green' | 'magenta' = ref === 'main' || ref === 'master' ? 'green' : 'magenta'
    return (
      <>
        <Text color={refColor}>{ref}</Text>
        <Text dim>@{member.lockInfo.commit.slice(0, 7)}</Text>
      </>
    )
  }
  if (member.isLocal) {
    return <Text dim>(local)</Text>
  }
  return null
}

/** Single member line */
const MemberLine = ({
  member,
  isCurrent,
  prefix = '',
}: {
  member: MemberStatus
  isCurrent: boolean
  prefix?: string
}) => {
  // Use 256-color dark gray (index 236) for current line highlight
  const bgColor = isCurrent ? { ansi256: 236 } : undefined

  return (
    <Box flexDirection="row" backgroundColor={bgColor} extendBackground={isCurrent}>
      <Text>{prefix}</Text>
      <MemberSymbol member={member} />
      <Text> </Text>
      {isCurrent ? (
        <Text bold color="cyan">
          {member.name}
        </Text>
      ) : (
        <Text bold>{member.name}</Text>
      )}
      <Text> </Text>
      <BranchInfo member={member} />
      {member.gitStatus?.isDirty && (
        <>
          <Text> </Text>
          <Text color="yellow">{symbols.dirty}</Text>
        </>
      )}
      {member.gitStatus?.hasUnpushed && (
        <>
          <Text> </Text>
          <Text color="red">{symbols.ahead}</Text>
        </>
      )}
      {member.lockInfo?.pinned && (
        <>
          <Text> </Text>
          <Text color="yellow">pinned</Text>
        </>
      )}
      {member.isMegarepo && (
        <>
          <Text> </Text>
          <Text color="cyan">[megarepo]</Text>
        </>
      )}
      {!member.exists && <Text dim> (not synced)</Text>}
    </Box>
  )
}

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
        const branchChar = isLast ? tree.last : tree.middle
        const isOnCurrentPath = currentPath !== undefined && currentPath[0] === member.name
        const isCurrent = isOnCurrentPath && currentPath.length === 1

        return (
          <React.Fragment key={member.name}>
            <MemberLine member={member} isCurrent={isCurrent} prefix={`${prefix}${branchChar}`} />
            {member.isMegarepo && member.nestedMembers && member.nestedMembers.length > 0 && (
              <MembersTree
                members={member.nestedMembers}
                prefix={prefix + (isLast ? tree.empty : tree.vertical)}
                currentPath={isOnCurrentPath ? currentPath.slice(1) : undefined}
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

  if (lastSyncTime) {
    const date = new Date(lastSyncTime)
    if (!Number.isNaN(date.getTime())) {
      parts.push(`synced ${formatRelativeTime(date)}`)
    }
  }

  return <Text dim>{parts.join(` ${symbols.dot} `)}</Text>
}

/** Legend component */
const Legend = ({ members }: { members: readonly MemberStatus[] }) => {
  const used = detectUsedSymbols(members)
  const items: LegendItem[] = []

  if (used.hasNotSynced) {
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
  if (used.hasDirty) {
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
  if (used.hasUnpushed) {
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
  if (used.hasPinned) {
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
