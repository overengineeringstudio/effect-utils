/**
 * Styled status output renderer following the CLI style guide
 *
 * @see /context/cli-design/CLI_STYLE_GUIDE.md
 */

import path from 'node:path'

import {
  isDiverged,
  isMember,
  type PackageIndexEntry,
  type RepoInfo,
} from '../lib/mod.ts'
import {
  collectPackageMappings,
  getUniqueMappings,
  type PackageMapping,
} from './link.ts'

// =============================================================================
// ANSI Color Codes
// =============================================================================

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
  bgYellow: '\x1b[43m',
  black: '\x1b[30m',
}

const styled = {
  bold: (s: string) => `${c.bold}${s}${c.reset}`,
  dim: (s: string) => `${c.dim}${s}${c.reset}`,
  red: (s: string) => `${c.red}${s}${c.reset}`,
  green: (s: string) => `${c.green}${s}${c.reset}`,
  yellow: (s: string) => `${c.yellow}${s}${c.reset}`,
  blue: (s: string) => `${c.blue}${s}${c.reset}`,
  cyan: (s: string) => `${c.cyan}${s}${c.reset}`,
  magenta: (s: string) => `${c.magenta}${s}${c.reset}`,
}

// =============================================================================
// Problem Analysis
// =============================================================================

type CriticalProblem =
  | { _tag: 'missing'; repo: RepoInfo }

type WarningProblem =
  | { _tag: 'diverged'; repo: RepoInfo }
  | { _tag: 'dirty'; repos: RepoInfo[] }

type Problems = {
  critical: CriticalProblem[]
  warnings: WarningProblem[]
}

const analyzeProblems = (repos: RepoInfo[]): Problems => {
  const critical: CriticalProblem[] = []
  const warnings: WarningProblem[] = []

  // Find missing repos (CRITICAL)
  for (const repo of repos) {
    if (repo.fsState._tag === 'missing') {
      critical.push({ _tag: 'missing', repo })
    }
  }

  // Find diverged repos (WARNING)
  for (const repo of repos) {
    if (isDiverged(repo)) {
      warnings.push({ _tag: 'diverged', repo })
    }
  }

  // Find dirty repos (WARNING - grouped)
  const dirtyRepos = repos.filter((r) => r.gitState?.isDirty)
  if (dirtyRepos.length > 0) {
    warnings.push({ _tag: 'dirty', repos: dirtyRepos })
  }

  return { critical, warnings }
}

// =============================================================================
// Rendering Helpers
// =============================================================================

const SEPARATOR = '─'.repeat(40)
const MAX_LIST_ITEMS = 5

/** Format branch name with appropriate color */
const formatBranch = (branch: string): string => {
  if (branch === 'main' || branch === 'master') {
    return styled.green(branch)
  } else if (branch === 'HEAD') {
    return styled.blue(branch)
  } else {
    return styled.magenta(branch)
  }
}

/** Render a truncated list with "+ N more" indicator */
const renderList = (items: string[], indent: string): string[] => {
  const lines: string[] = []
  const shown = items.slice(0, MAX_LIST_ITEMS)
  const remaining = items.length - MAX_LIST_ITEMS

  for (const item of shown) {
    lines.push(`${indent}${styled.cyan(item)}`)
  }

  if (remaining > 0) {
    lines.push(`${indent}${styled.dim(`+ ${remaining} more`)}`)
  }

  return lines
}

// =============================================================================
// Problem Section Rendering
// =============================================================================

const renderCriticalSection = (problems: CriticalProblem[]): string[] => {
  if (problems.length === 0) return []

  const lines: string[] = []
  lines.push(`${c.bgRed}${c.white}${c.bold} CRITICAL ${c.reset}`)
  lines.push('')

  for (const problem of problems) {
    if (problem._tag === 'missing') {
      lines.push(`  ${styled.bold(problem.repo.name)} ${styled.dim('missing')}`)
      lines.push(`    ${styled.cyan('fix:')} dotdot clone ${problem.repo.name}`)
      lines.push(`    ${styled.cyan('fix:')} git clone <url> ${problem.repo.name}`)
      lines.push(`    ${styled.dim('skip:')} dotdot ignore ${problem.repo.name}`)
      lines.push('')
    }
  }

  return lines
}

const renderWarningSection = (problems: WarningProblem[]): string[] => {
  if (problems.length === 0) return []

  const lines: string[] = []
  lines.push(`${c.bgYellow}${c.black}${c.bold} WARNING ${c.reset}`)
  lines.push('')

  for (const problem of problems) {
    if (problem._tag === 'diverged') {
      const localRev = problem.repo.gitState?.shortRev ?? 'unknown'
      const remoteRev = problem.repo.pinnedRev?.slice(0, 7) ?? 'unknown'
      lines.push(
        `  ${styled.bold(problem.repo.name)} ${styled.dim('diverged')} ${styled.dim(`(local: ${localRev}, remote: ${remoteRev})`)}`,
      )
      lines.push(`    ${styled.cyan('fix:')} cd ${problem.repo.name} && git pull --rebase`)
      lines.push(`    ${styled.cyan('fix:')} dotdot sync ${problem.repo.name}`)
      lines.push(`    ${styled.dim('skip:')} dotdot ignore ${problem.repo.name} --diverged`)
      lines.push('')
    } else if (problem._tag === 'dirty') {
      const count = problem.repos.length
      const repoNames = problem.repos.map((r) => r.name)
      lines.push(
        `  ${styled.bold(`${count} repos`)} ${styled.dim('have uncommitted changes')}`,
      )
      lines.push(`    ${styled.dim(repoNames.join(', '))}`)
      lines.push(`    ${styled.cyan('fix:')} dotdot commit -a`)
      lines.push(`    ${styled.cyan('fix:')} git status <repo> ${styled.dim('to review')}`)
      lines.push('')
    }
  }

  return lines
}

// =============================================================================
// Main Content Rendering
// =============================================================================

type RepoRenderContext = {
  workspaceRoot: string
  packagesByRepo: Map<string, PackageMapping[]>
  depsByMember: Map<string, string[]>
}

const renderRepo = (repo: RepoInfo, ctx: RepoRenderContext): string[] => {
  const lines: string[] = []

  // Skip missing repos in main content (shown in CRITICAL section)
  if (repo.fsState._tag === 'missing') {
    return lines
  }

  // Build main line: name branch@hash status-symbols relationship
  const parts: string[] = []
  parts.push(styled.bold(repo.name))

  if (repo.gitState) {
    parts.push(`${formatBranch(repo.gitState.branch)}${styled.dim(`@${repo.gitState.shortRev}`)}`)

    // Status symbols
    if (repo.gitState.isDirty) {
      parts.push(styled.yellow('*'))
    }
    if (isDiverged(repo)) {
      parts.push(styled.red(`↕${repo.pinnedRev?.slice(0, 7)}`))
    }
  }

  // Relationship (deps this repo depends on)
  const memberDeps = ctx.depsByMember.get(repo.name) ?? []
  if (memberDeps.length > 0) {
    parts.push(styled.dim(`← ${memberDeps.join(', ')}`))
  }

  lines.push(parts.join(' '))

  // Show packages (links) if any
  const repoPackages = ctx.packagesByRepo.get(repo.name) ?? []
  if (repoPackages.length > 0) {
    lines.push(`  ${styled.dim(`packages(${repoPackages.length}):`)}`)
    const packageNames = repoPackages.map((p) => p.targetName)
    lines.push(...renderList(packageNames, '    '))
  }

  return lines
}

// =============================================================================
// Main Renderer
// =============================================================================

export type StatusRenderInput = {
  workspaceRoot: string
  allRepos: RepoInfo[]
  packages: Record<string, PackageIndexEntry>
  memberConfigs: { repoName: string; config: { deps?: Record<string, unknown> | undefined } }[]
}

/** Renders styled status output and returns all lines */
export const renderStyledStatus = ({
  workspaceRoot,
  allRepos,
  packages,
  memberConfigs,
}: StatusRenderInput): string[] => {
  const output: string[] = []

  // Analyze problems
  const problems = analyzeProblems(allRepos)
  const hasProblems = problems.critical.length > 0 || problems.warnings.length > 0

  // Collect package mappings for symlink status
  const mappings = collectPackageMappings({ workspaceRoot, packages })
  const uniqueMappings = getUniqueMappings(mappings)

  // Group packages by source repo
  const packagesByRepo = new Map<string, PackageMapping[]>()
  for (const mapping of uniqueMappings.values()) {
    const existing = packagesByRepo.get(mapping.sourceRepo) ?? []
    existing.push(mapping)
    packagesByRepo.set(mapping.sourceRepo, existing)
  }

  // Get deps by member
  const depsByMember = new Map<string, string[]>()
  for (const memberConfig of memberConfigs) {
    if (memberConfig.config.deps) {
      depsByMember.set(memberConfig.repoName, Object.keys(memberConfig.config.deps))
    }
  }

  // Context header
  output.push(`${styled.dim('workspace:')} ${path.basename(workspaceRoot)}`)
  output.push('')

  // Problem sections
  if (hasProblems) {
    output.push(...renderCriticalSection(problems.critical))
    output.push(...renderWarningSection(problems.warnings))

    // Separator
    output.push(styled.dim(SEPARATOR))
    output.push('')
  }

  // Main content - repos
  const ctx: RepoRenderContext = { workspaceRoot, packagesByRepo, depsByMember }

  // Partition repos
  const members = allRepos.filter(isMember)
  const dependencies = allRepos.filter((r) => r.tracking._tag === 'dependency')

  // Show members
  for (const member of members) {
    const lines = renderRepo(member, ctx)
    output.push(...lines)
    if (lines.length > 0) {
      output.push('')
    }
  }

  // Show standalone dependencies (not missing)
  const shownDeps = new Set<string>()
  for (const memberConfig of memberConfigs) {
    const deps = memberConfig.config.deps ?? {}
    for (const depName of Object.keys(deps)) {
      shownDeps.add(depName)
    }
  }

  const standaloneDeps = dependencies.filter(
    (d) => !shownDeps.has(d.name) && d.fsState._tag !== 'missing',
  )
  for (const dep of standaloneDeps) {
    const lines = renderRepo(dep, ctx)
    output.push(...lines)
    if (lines.length > 0) {
      output.push('')
    }
  }

  // Summary line
  const memberCount = members.length
  const depCount = dependencies.filter((d) => d.fsState._tag !== 'missing').length
  output.push(styled.dim(`${memberCount} members · ${depCount} deps`))

  return output
}
