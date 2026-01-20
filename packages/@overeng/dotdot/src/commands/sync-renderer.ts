/**
 * Styled sync output renderer following the CLI style guide
 *
 * Diff-focused: shows what WOULD change, not everything that exists
 */

import { kv, separator, styled, symbols } from '@overeng/cli-ui'

import type { ExecutionMode } from '../lib/mod.ts'

// =============================================================================
// Types
// =============================================================================

/** Repository to clone during sync */
export type RepoToClone = {
  name: string
  url: string
  install?: string
}

/** Repository to checkout a specific revision */
export type RepoToCheckout = {
  name: string
  fromRev: string
  toRev: string
}

/** Repo issue types that need user attention */
export type RepoIssue =
  | { _tag: 'missing-url'; name: string; declaredBy: string }
  | { _tag: 'not-a-git-repo'; name: string }
  | { _tag: 'dirty-working-tree'; name: string }

/** Package to add during sync */
export type PackageToAdd = {
  name: string
  repo: string
}

/** Package to remove during sync */
export type PackageToRemove = {
  name: string
}

/** Package that requires running install command */
export type PackageWithInstall = {
  name: string
  install: string
}

/** Diff of changes to apply during sync */
export type SyncDiff = {
  repos: {
    toClone: RepoToClone[]
    toCheckout: RepoToCheckout[]
    issues: RepoIssue[]
    unchanged: number
  }
  packages: {
    toAdd: PackageToAdd[]
    toRemove: PackageToRemove[]
    withInstall: PackageWithInstall[]
    unchanged: number
  }
}

/** Input for rendering sync dry-run output */
export type SyncDryRunInput = {
  workspaceName: string
  mode: ExecutionMode
  diff: SyncDiff
  danglingRepos?: string[]
}

// =============================================================================
// Rendering Helpers
// =============================================================================

// oxlint-disable-next-line overeng/named-args -- internal formatter function
const actionLine = (
  action: string,
  actionStyle: (s: string) => string,
  text: string,
  detail?: string,
) => {
  const a = actionStyle(action)
  const d = detail ? `  ${styled.dim(detail)}` : ''
  return `  ${a} ${text}${d}`
}

// =============================================================================
// Main Renderer
// =============================================================================

/** Renders styled dry-run output and returns all lines */
export const renderSyncDryRun = ({
  workspaceName,
  mode,
  diff,
  danglingRepos,
}: SyncDryRunInput): string[] => {
  const output: string[] = []

  // Header
  output.push(kv('workspace', workspaceName))
  output.push(styled.dim(`dry run ${symbols.dot} ${mode} mode`))
  output.push('')

  // Dangling repos warning
  if (danglingRepos && danglingRepos.length > 0) {
    output.push(styled.yellow(`${symbols.warning} ${danglingRepos.length} dangling repo(s):`))
    for (const name of danglingRepos) {
      output.push(
        `  ${styled.dim(symbols.bullet)} ${styled.bold(name)} ${styled.dim('(not tracked)')}`,
      )
    }
    output.push('')
  }

  // Check if there are any changes
  const hasRepoChanges = diff.repos.toClone.length > 0 || diff.repos.toCheckout.length > 0
  const hasRepoIssues = diff.repos.issues.length > 0
  const hasPackageChanges = diff.packages.toAdd.length > 0 || diff.packages.toRemove.length > 0
  const hasInstalls = diff.packages.withInstall.length > 0

  if (!hasRepoChanges && !hasPackageChanges && !hasInstalls && !hasRepoIssues) {
    output.push(`${styled.green(symbols.check)} ${styled.dim('workspace is up to date')}`)
    output.push('')
    const totalRepos = diff.repos.unchanged
    const totalPackages = diff.packages.unchanged
    output.push(styled.dim(`${totalRepos} repos ${symbols.dot} ${totalPackages} packages`))
    return output
  }

  // Repos section
  if (hasRepoChanges || diff.repos.unchanged > 0) {
    output.push(styled.dim('repos:'))
    for (const r of diff.repos.toClone) {
      output.push(actionLine('will clone', styled.green, r.name, 'because not on disk'))
    }
    for (const r of diff.repos.toCheckout) {
      output.push(
        actionLine(
          'will checkout',
          styled.yellow,
          r.name,
          `because pinned rev changed (${r.fromRev.slice(0, 7)} → ${r.toRev.slice(0, 7)})`,
        ),
      )
    }
    if (diff.repos.unchanged > 0) {
      output.push(`  ${styled.dim(`${diff.repos.unchanged} unchanged`)}`)
    }
    output.push('')
  }

  // Issues section (needs attention)
  if (hasRepoIssues) {
    output.push(styled.yellow(`${symbols.warning} needs attention:`))
    for (const issue of diff.repos.issues) {
      switch (issue._tag) {
        case 'missing-url':
          output.push(
            `  ${styled.bold(issue.name)}  ${styled.dim(`declared by ${issue.declaredBy} but has no clone URL`)}`,
          )
          break
        case 'not-a-git-repo':
          output.push(
            `  ${styled.bold(issue.name)}  ${styled.dim('directory exists but is not a git repo')}`,
          )
          break
        case 'dirty-working-tree':
          output.push(
            `  ${styled.bold(issue.name)}  ${styled.dim('has uncommitted changes (use --force to override)')}`,
          )
          break
      }
    }
    output.push('')
  }

  // Packages section
  if (hasPackageChanges || diff.packages.unchanged > 0) {
    output.push(styled.dim('packages:'))
    for (const p of diff.packages.toAdd) {
      output.push(actionLine('will add', styled.green, p.name, `because exposed by ${p.repo}`))
    }
    for (const p of diff.packages.toRemove) {
      output.push(actionLine('will remove', styled.red, p.name, 'because no longer exposed'))
    }
    if (diff.packages.unchanged > 0) {
      output.push(`  ${styled.dim(`${diff.packages.unchanged} unchanged`)}`)
    }
    output.push('')
  }

  // Install commands section
  if (hasInstalls) {
    output.push(styled.dim('will run install:'))
    for (const p of diff.packages.withInstall) {
      output.push(`  ${styled.cyan(p.name)} ${styled.dim(`(${p.install})`)}`)
    }
    output.push('')
  }

  // Footer summary
  output.push(separator())
  const parts: string[] = []
  if (diff.repos.toClone.length > 0) {
    parts.push(`${diff.repos.toClone.length} to clone`)
  }
  if (diff.repos.toCheckout.length > 0) {
    parts.push(`${diff.repos.toCheckout.length} to checkout`)
  }
  if (diff.packages.toAdd.length > 0) {
    parts.push(`${diff.packages.toAdd.length} packages to add`)
  }
  if (diff.packages.toRemove.length > 0) {
    parts.push(`${diff.packages.toRemove.length} to remove`)
  }
  if (hasInstalls) {
    parts.push(`${diff.packages.withInstall.length} installs`)
  }
  if (hasRepoIssues) {
    parts.push(styled.yellow(`${diff.repos.issues.length} issues`))
  }
  output.push(styled.dim(parts.join(' · ')))

  return output
}
