/**
 * Status command renderer
 *
 * Renders workspace status following the CLI style guide.
 * Supports nested megarepo tree display with problem-first badges.
 *
 * @see /context/cli-design/CLI_STYLE_GUIDE.md
 */

import { badge, highlightLine, kv, separator, styled, symbols } from '@overeng/cli-ui'

// =============================================================================
// Types
// =============================================================================

/** Git status information for a member */
export type GitStatus = {
  /** Whether the working tree has uncommitted changes */
  isDirty: boolean
  /** Number of uncommitted changes */
  changesCount: number
  /** Whether there are unpushed commits */
  hasUnpushed: boolean
  /** Current branch name */
  branch: string | undefined
  /** Current commit (short) */
  shortRev: string | undefined
}

/** Member status information */
export type MemberStatus = {
  name: string
  exists: boolean
  source: string
  /** Whether this is a local path source */
  isLocal: boolean
  /** Lock file info for remote sources */
  lockInfo:
    | {
        ref: string
        commit: string
        pinned: boolean
      }
    | undefined
  /** Whether this member is itself a megarepo */
  isMegarepo: boolean
  /** Nested members if this is a megarepo (recursive) */
  nestedMembers: readonly MemberStatus[] | undefined
  /** Git status (if member exists and is a git repo) */
  gitStatus: GitStatus | undefined
}

/** Lock file staleness information */
export type LockStaleness = {
  /** Whether the lock file exists */
  exists: boolean
  /** Members in config but not in lock file */
  missingFromLock: readonly string[]
  /** Members in lock file but not in config */
  extraInLock: readonly string[]
}

/** Input for rendering status output */
export type StatusRenderInput = {
  name: string
  root: string
  members: readonly MemberStatus[]
  /** Last sync timestamp (from lock file) */
  lastSyncTime: Date | undefined
  /** Lock file staleness info */
  lockStaleness: LockStaleness | undefined
  /** Current working directory's megarepo path (for highlighting current location) */
  currentMemberPath: readonly string[] | undefined
}

// =============================================================================
// Problem Analysis
// =============================================================================

type Problem =
  | { _tag: 'not_synced'; members: MemberStatus[] }
  | { _tag: 'dirty'; members: MemberStatus[] }
  | { _tag: 'unpushed'; members: MemberStatus[] }
  | { _tag: 'lock_missing' }
  | { _tag: 'lock_stale'; missingFromLock: readonly string[]; extraInLock: readonly string[] }

type Problems = {
  warnings: Problem[]
}

/** Recursively collect all members (flattened) */
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

/** Analyze members for problems */
const analyzeProblems = ({
  members,
  lockStaleness,
}: {
  members: readonly MemberStatus[]
  lockStaleness: LockStaleness | undefined
}): Problems => {
  const warnings: Problem[] = []
  const allMembers = flattenMembers(members)

  // Check lock file staleness first (higher priority)
  if (lockStaleness !== undefined) {
    if (!lockStaleness.exists) {
      // Only warn about missing lock if there are remote members
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

  // Find not synced members
  const notSynced = allMembers.filter((m) => !m.exists)
  if (notSynced.length > 0) {
    warnings.push({ _tag: 'not_synced', members: notSynced })
  }

  // Find dirty members (uncommitted changes)
  const dirty = allMembers.filter((m) => m.gitStatus?.isDirty)
  if (dirty.length > 0) {
    warnings.push({ _tag: 'dirty', members: dirty })
  }

  // Find members with unpushed commits
  const unpushed = allMembers.filter((m) => m.gitStatus?.hasUnpushed)
  if (unpushed.length > 0) {
    warnings.push({ _tag: 'unpushed', members: unpushed })
  }

  return { warnings }
}

// =============================================================================
// Problem Section Rendering
// =============================================================================

const renderWarningSection = (problems: Problem[]): string[] => {
  if (problems.length === 0) return []

  const lines: string[] = []
  lines.push(badge('WARNING', 'warning'))
  lines.push('')

  for (const problem of problems) {
    switch (problem._tag) {
      case 'lock_missing': {
        lines.push(`  ${styled.bold('Lock file missing')}`)
        lines.push(`    ${styled.dim('Remote members are not tracked in lock file')}`)
        lines.push(`    ${styled.cyan('fix:')} mr sync`)
        lines.push('')
        break
      }
      case 'lock_stale': {
        lines.push(`  ${styled.bold('Lock file is stale')}`)
        if (problem.missingFromLock.length > 0) {
          lines.push(`    ${styled.dim('Not in lock:')} ${problem.missingFromLock.join(', ')}`)
        }
        if (problem.extraInLock.length > 0) {
          lines.push(`    ${styled.dim('Removed from config:')} ${problem.extraInLock.join(', ')}`)
        }
        lines.push(`    ${styled.cyan('fix:')} mr sync`)
        lines.push('')
        break
      }
      case 'not_synced': {
        const count = problem.members.length
        const names = problem.members.map((m) => m.name)
        lines.push(
          `  ${styled.bold(`${count} member${count > 1 ? 's' : ''}`)} ${styled.dim('not synced')}`,
        )
        lines.push(`    ${styled.dim(names.join(', '))}`)
        lines.push(`    ${styled.cyan('fix:')} mr sync`)
        lines.push('')
        break
      }
      case 'dirty': {
        const count = problem.members.length
        const names = problem.members.map((m) => {
          const changes = m.gitStatus?.changesCount ?? 0
          return changes > 0 ? `${m.name} (${changes})` : m.name
        })
        lines.push(
          `  ${styled.bold(`${count} member${count > 1 ? 's' : ''}`)} ${styled.dim('have uncommitted changes')}`,
        )
        lines.push(`    ${styled.dim(names.join(', '))}`)
        lines.push(`    ${styled.cyan('fix:')} git status <member>`)
        lines.push('')
        break
      }
      case 'unpushed': {
        const count = problem.members.length
        const names = problem.members.map((m) => m.name)
        lines.push(
          `  ${styled.bold(`${count} member${count > 1 ? 's' : ''}`)} ${styled.dim('have unpushed commits')}`,
        )
        lines.push(`    ${styled.dim(names.join(', '))}`)
        lines.push(`    ${styled.cyan('fix:')} cd <member> && git push`)
        lines.push('')
        break
      }
    }
  }

  return lines
}

// =============================================================================
// Tree Rendering Helpers
// =============================================================================

/** Tree branch characters */
const tree = {
  middle: '├── ',
  last: '└── ',
  vertical: '│   ',
  empty: '    ',
} as const

/** Format a single member line content (without tree prefix or highlighting) */
const formatMemberContent = ({
  member,
  isCurrent,
}: {
  member: MemberStatus
  isCurrent: boolean
}): string => {
  const parts: string[] = []

  // Status symbol
  if (!member.exists) {
    parts.push(styled.yellow(symbols.circle))
  } else if (member.gitStatus?.isDirty) {
    parts.push(styled.yellow(symbols.check))
  } else {
    parts.push(styled.green(symbols.check))
  }

  // Name (extra bold/highlighted if current)
  if (isCurrent) {
    parts.push(styled.bold(styled.cyan(member.name)))
  } else {
    parts.push(styled.bold(member.name))
  }

  // Branch and commit info
  if (member.gitStatus?.branch && member.gitStatus?.shortRev) {
    const branchPart =
      member.gitStatus.branch === 'main' || member.gitStatus.branch === 'master'
        ? styled.green(member.gitStatus.branch)
        : member.gitStatus.branch === 'HEAD'
          ? styled.blue(member.gitStatus.branch)
          : styled.magenta(member.gitStatus.branch)
    parts.push(`${branchPart}${styled.dim(`@${member.gitStatus.shortRev}`)}`)
  } else if (member.lockInfo) {
    // Fall back to lock info if no git status
    const refPart =
      member.lockInfo.ref === 'main' || member.lockInfo.ref === 'master'
        ? styled.green(member.lockInfo.ref)
        : styled.magenta(member.lockInfo.ref)
    parts.push(`${refPart}${styled.dim(`@${member.lockInfo.commit.slice(0, 7)}`)}`)
  } else if (member.isLocal) {
    parts.push(styled.dim('(local)'))
  }

  // Status indicators
  if (member.gitStatus?.isDirty) {
    parts.push(styled.yellow(symbols.dirty))
  }
  if (member.gitStatus?.hasUnpushed) {
    parts.push(styled.red(symbols.ahead))
  }
  if (member.lockInfo?.pinned) {
    parts.push(styled.yellow('pinned'))
  }

  // Megarepo indicator
  if (member.isMegarepo) {
    parts.push(styled.cyan('[megarepo]'))
  }

  // Not synced indicator
  if (!member.exists) {
    parts.push(styled.dim('(not synced)'))
  }

  return parts.join(' ')
}

/** Format a complete member line with optional prefix and highlighting */
const formatMemberLine = ({
  member,
  isCurrent,
  prefix = '',
}: {
  member: MemberStatus
  isCurrent: boolean
  prefix?: string
}): string => {
  const content = formatMemberContent({ member, isCurrent })
  const line = `${prefix}${content}`

  // Apply full-width background highlight for current location
  if (isCurrent) {
    return highlightLine(line)
  }

  return line
}

/**
 * Render members recursively with tree structure
 */
const renderMembersTree = ({
  members,
  prefix,
  output,
  currentPath,
  depth,
}: {
  members: readonly MemberStatus[]
  prefix: string
  output: string[]
  /** Remaining path segments to the current location */
  currentPath: readonly string[] | undefined
  /** Current depth in the tree */
  depth: number
}): void => {
  for (let i = 0; i < members.length; i++) {
    const member = members[i]!
    const isLast = i === members.length - 1
    const branchChar = isLast ? tree.last : tree.middle

    // Check if this member is on the path to current location
    const isOnCurrentPath = currentPath !== undefined && currentPath[0] === member.name
    const isCurrent = isOnCurrentPath && currentPath.length === 1

    // Render this member with tree prefix included in the line (for proper highlighting)
    output.push(formatMemberLine({ member, isCurrent, prefix: `${prefix}${branchChar}` }))

    // Render nested members if this is a megarepo with nested members
    if (member.isMegarepo && member.nestedMembers && member.nestedMembers.length > 0) {
      const nestedPrefix = prefix + (isLast ? tree.empty : tree.vertical)
      renderMembersTree({
        members: member.nestedMembers,
        prefix: nestedPrefix,
        output,
        currentPath: isOnCurrentPath ? currentPath.slice(1) : undefined,
        depth: depth + 1,
      })
    }
  }
}

// =============================================================================
// Summary Helpers
// =============================================================================

/** Count members at different levels */
const countMembers = (
  members: readonly MemberStatus[],
): { direct: number; nested: number; synced: number; total: number; megarepos: number } => {
  const direct = members.length
  let nested = 0
  let synced = 0
  let megarepos = 0

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
      if (m.isMegarepo) megarepos++
      if (m.nestedMembers) {
        countRecursive({ ms: m.nestedMembers, isNested: true })
      }
    }
  }

  // Count direct members
  for (const m of members) {
    if (m.exists) synced++
    if (m.isMegarepo) megarepos++
    if (m.nestedMembers) {
      countRecursive({ ms: m.nestedMembers, isNested: true })
    }
  }

  return { direct, nested, synced, total: direct + nested, megarepos }
}

/** Format relative time (e.g., "2h ago", "3d ago") */
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

// =============================================================================
// Main Renderer
// =============================================================================

/** Detect which symbols are used in the member list for legend */
const detectUsedSymbols = (members: readonly MemberStatus[]): {
  hasDirty: boolean
  hasUnpushed: boolean
  hasPinned: boolean
  hasNotSynced: boolean
} => {
  const allMembers = flattenMembers(members)
  return {
    hasDirty: allMembers.some((m) => m.gitStatus?.isDirty),
    hasUnpushed: allMembers.some((m) => m.gitStatus?.hasUnpushed),
    hasPinned: allMembers.some((m) => m.lockInfo?.pinned),
    hasNotSynced: allMembers.some((m) => !m.exists),
  }
}

/** Render conditional legend */
const renderLegend = (usedSymbols: ReturnType<typeof detectUsedSymbols>): string[] => {
  const legendItems: string[] = []

  if (usedSymbols.hasNotSynced) {
    legendItems.push(`${styled.yellow(symbols.circle)} not synced`)
  }
  if (usedSymbols.hasDirty) {
    legendItems.push(`${styled.yellow(symbols.dirty)} uncommitted`)
  }
  if (usedSymbols.hasUnpushed) {
    legendItems.push(`${styled.red(symbols.ahead)} unpushed`)
  }
  if (usedSymbols.hasPinned) {
    legendItems.push(`${styled.yellow('pinned')}`)
  }

  if (legendItems.length === 0) {
    return []
  }

  return [styled.dim('Legend: ') + legendItems.join('  ')]
}

/** Render workspace status output */
export const renderStatus = ({
  name,
  root,
  members,
  lastSyncTime,
  lockStaleness,
  currentMemberPath,
}: StatusRenderInput): string[] => {
  const output: string[] = []

  // Header
  output.push(styled.bold(name))
  output.push(kv('root', root, { keyStyle: (k) => styled.dim(`  ${k}`) }))
  output.push('')

  // Analyze problems
  const problems = analyzeProblems({ members, lockStaleness })
  const hasProblems = problems.warnings.length > 0

  // Render problem sections
  if (hasProblems) {
    output.push(...renderWarningSection(problems.warnings))
    output.push(separator())
    output.push('')
  }

  // Check if any member has nested members (tree mode)
  const hasNesting = members.some((m) => m.nestedMembers && m.nestedMembers.length > 0)

  if (hasNesting) {
    // Tree mode: render with tree structure
    for (let i = 0; i < members.length; i++) {
      const member = members[i]!

      // Check if this member is on the path to current location
      const isOnCurrentPath =
        currentMemberPath !== undefined && currentMemberPath[0] === member.name
      const isCurrent = isOnCurrentPath && currentMemberPath.length === 1

      // Render top-level member
      output.push(formatMemberLine({ member, isCurrent }))

      // Render nested members if this is a megarepo with nested members
      if (member.isMegarepo && member.nestedMembers && member.nestedMembers.length > 0) {
        renderMembersTree({
          members: member.nestedMembers,
          prefix: '',
          output,
          currentPath: isOnCurrentPath ? currentMemberPath.slice(1) : undefined,
          depth: 1,
        })
      }

      // Add spacing between top-level members (except last)
      if (i < members.length - 1) {
        output.push('')
      }
    }
  } else {
    // Flat mode: simple list (original behavior)
    for (const member of members) {
      const isCurrent =
        currentMemberPath !== undefined &&
        currentMemberPath.length === 1 &&
        currentMemberPath[0] === member.name
      output.push(formatMemberLine({ member, isCurrent }))
    }
  }

  // Summary line
  output.push('')
  const counts = countMembers(members)

  const summaryParts: string[] = []

  // Direct/nested counts
  if (counts.nested > 0) {
    summaryParts.push(`${counts.direct} direct`)
    summaryParts.push(`${counts.nested} nested`)
  } else {
    summaryParts.push(`${counts.total} members`)
  }

  // Sync status (only if some not synced)
  if (counts.synced < counts.total) {
    summaryParts.push(`${counts.synced}/${counts.total} synced`)
  }

  // Last sync time
  if (lastSyncTime) {
    summaryParts.push(`synced ${formatRelativeTime(lastSyncTime)}`)
  }

  output.push(styled.dim(summaryParts.join(` ${symbols.dot} `)))

  // Conditional legend
  const usedSymbols = detectUsedSymbols(members)
  const legend = renderLegend(usedSymbols)
  if (legend.length > 0) {
    output.push(...legend)
  }

  return output
}
