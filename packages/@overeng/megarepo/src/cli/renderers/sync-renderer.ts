/**
 * Sync command renderer
 *
 * Renders sync operation output following the CLI style guide.
 * Matches the status command style with header, content, and summary.
 *
 * @see /context/cli-design/CLI_STYLE_GUIDE.md
 */

import { kv, separator, styled, symbols } from '@overeng/cli-ui'

// =============================================================================
// Types
// =============================================================================

/** Sync result for a single member */
export type MemberSyncResult = {
  readonly name: string
  readonly status:
    | 'cloned'
    | 'synced'
    | 'already_synced'
    | 'skipped'
    | 'error'
    | 'updated'
    | 'locked'
    | 'removed'
  readonly message?: string | undefined
  /** Commit that was synced to (for display) */
  readonly commit?: string | undefined
  /** Previous commit (for showing lock updates) */
  readonly previousCommit?: string | undefined
  /** Ref that was synced to */
  readonly ref?: string | undefined
  /** Whether the lock was updated for this member */
  readonly lockUpdated?: boolean | undefined
}

/** Input for rendering sync output */
export type SyncRenderInput = {
  /** Workspace name */
  name: string
  /** Workspace root path */
  root: string
  /** Sync results for each member */
  results: readonly MemberSyncResult[]
  /** Members that are themselves megarepos */
  nestedMegarepos: readonly string[]
  /** Whether --deep flag was used */
  deep: boolean
  /** Whether --dry-run flag was used */
  dryRun: boolean
  /** Whether --frozen flag was used */
  frozen: boolean
  /** Whether --pull flag was used */
  pull?: boolean | undefined
  /** List of generated file paths (empty in dry-run mode) */
  generatedFiles?: readonly string[] | undefined
}

// =============================================================================
// Helpers
// =============================================================================

/** Count sync results by status */
const countResults = (
  results: readonly MemberSyncResult[],
): {
  cloned: number
  synced: number
  updated: number
  locked: number
  alreadySynced: number
  skipped: number
  errors: number
  removed: number
} => {
  let cloned = 0
  let synced = 0
  let updated = 0
  let locked = 0
  let alreadySynced = 0
  let skipped = 0
  let errors = 0
  let removed = 0

  for (const r of results) {
    switch (r.status) {
      case 'cloned':
        cloned++
        break
      case 'synced':
        synced++
        break
      case 'updated':
        updated++
        break
      case 'locked':
        locked++
        break
      case 'already_synced':
        alreadySynced++
        break
      case 'skipped':
        skipped++
        break
      case 'error':
        errors++
        break
      case 'removed':
        removed++
        break
    }
  }

  return { cloned, synced, updated, locked, alreadySynced, skipped, errors, removed }
}

/** Format status text for a result */
const formatStatusText = (result: MemberSyncResult): string => {
  switch (result.status) {
    case 'cloned':
      return 'cloned'
    case 'synced':
      return 'synced'
    case 'updated':
      return 'updated'
    case 'locked':
      return 'lock updated'
    case 'already_synced':
      return 'already synced'
    case 'skipped':
      return result.message ? `skipped: ${result.message}` : 'skipped'
    case 'error':
      return result.message ? `error: ${result.message}` : 'error'
    case 'removed':
      return 'removed'
  }
}

/** Get status symbol for a result */
const getStatusSymbol = (result: MemberSyncResult): string => {
  switch (result.status) {
    case 'cloned':
    case 'synced':
    case 'updated':
      return styled.green(symbols.check)
    case 'locked':
      return styled.cyan(symbols.check)
    case 'already_synced':
      return styled.dim(symbols.check)
    case 'skipped':
      return styled.yellow(symbols.circle)
    case 'error':
      return styled.red(symbols.cross)
    case 'removed':
      return styled.red(symbols.cross)
  }
}

// =============================================================================
// Main Renderer
// =============================================================================

/** Format commit transition (e.g., "abc1234 → def5678") */
const formatCommitTransition = (result: MemberSyncResult): string => {
  if (result.previousCommit && result.commit) {
    const prev = result.previousCommit.slice(0, 7)
    const curr = result.commit.slice(0, 7)
    return styled.dim(`${prev} → ${curr}`)
  }
  if (result.commit) {
    return styled.dim(result.commit.slice(0, 7))
  }
  return ''
}

/** Render sync output */
export const renderSync = ({
  name,
  root,
  results,
  nestedMegarepos,
  deep,
  dryRun,
  frozen,
  pull,
  generatedFiles,
}: SyncRenderInput): string[] => {
  const output: string[] = []

  // Header
  output.push(styled.bold(name))
  output.push(kv('root', root, { keyStyle: (k) => styled.dim(`  ${k}`) }))

  // Mode indicators
  const modeIndicators: string[] = []
  if (dryRun) modeIndicators.push('dry run')
  if (frozen) modeIndicators.push('frozen')
  if (pull) modeIndicators.push('pull')
  if (modeIndicators.length > 0) {
    output.push(styled.dim(`  mode: ${modeIndicators.join(', ')}`))
  }
  output.push('')

  // Member results
  const counts = countResults(results)
  const hasChanges =
    counts.cloned > 0 ||
    counts.synced > 0 ||
    counts.updated > 0 ||
    counts.locked > 0 ||
    counts.removed > 0 ||
    counts.errors > 0

  if (dryRun && !hasChanges && counts.errors === 0) {
    // Nothing would change
    output.push(`${styled.green(symbols.check)} ${styled.dim('workspace is up to date')}`)
  } else {
    // Show each member result
    // Group by status for cleaner output
    const cloned = results.filter((r) => r.status === 'cloned')
    const synced = results.filter((r) => r.status === 'synced')
    const updated = results.filter((r) => r.status === 'updated')
    const locked = results.filter((r) => r.status === 'locked')
    const removed = results.filter((r) => r.status === 'removed')
    const errors = results.filter((r) => r.status === 'error')
    const skipped = results.filter((r) => r.status === 'skipped')
    const alreadySynced = results.filter((r) => r.status === 'already_synced')

    // Show changes first (cloned, synced, updated)
    for (const r of cloned) {
      const refInfo = r.ref ? ` ${styled.dim(`(${r.ref})`)}` : ''
      output.push(
        `${getStatusSymbol(r)} ${styled.bold(r.name)} ${styled.green('cloned')}${refInfo}`,
      )
    }

    for (const r of synced) {
      const refInfo = r.ref ? ` ${styled.dim(`(${r.ref})`)}` : ''
      output.push(
        `${getStatusSymbol(r)} ${styled.bold(r.name)} ${styled.green('synced')}${refInfo}`,
      )
    }

    // Updated members (from --pull mode)
    for (const r of updated) {
      const commitInfo = formatCommitTransition(r)
      output.push(
        `${getStatusSymbol(r)} ${styled.bold(r.name)} ${styled.green('updated')} ${commitInfo}`,
      )
    }

    // Locked members (lock file updated to match current worktree)
    for (const r of locked) {
      const commitInfo = formatCommitTransition(r)
      output.push(
        `${getStatusSymbol(r)} ${styled.bold(r.name)} ${styled.cyan('lock updated')} ${commitInfo}`,
      )
    }

    // Removed members (orphaned symlinks)
    for (const r of removed) {
      const actionText = dryRun ? 'would remove' : 'removed'
      output.push(`${getStatusSymbol(r)} ${styled.bold(r.name)} ${styled.red(actionText)}`)
    }

    // Show errors
    for (const r of errors) {
      output.push(`${getStatusSymbol(r)} ${styled.bold(r.name)} ${styled.red(formatStatusText(r))}`)
    }

    // Show skipped
    for (const r of skipped) {
      output.push(
        `${getStatusSymbol(r)} ${styled.bold(r.name)} ${styled.yellow(formatStatusText(r))}`,
      )
    }

    // Show already synced (dimmed, compact if many)
    if (alreadySynced.length > 0) {
      if (alreadySynced.length <= 5 || hasChanges) {
        // Show individually if few, or if there were changes (to show full picture)
        for (const r of alreadySynced) {
          output.push(
            `${getStatusSymbol(r)} ${styled.bold(r.name)} ${styled.dim('already synced')}`,
          )
        }
      } else {
        // Compact display for many unchanged
        output.push(styled.dim(`${symbols.check} ${alreadySynced.length} members already synced`))
      }
    }
  }

  // Separator and summary
  output.push('')
  output.push(separator())

  const summaryParts: string[] = []

  if (dryRun) {
    // Dry run summary - what would happen
    if (counts.cloned > 0) summaryParts.push(`${counts.cloned} to clone`)
    if (counts.synced > 0) summaryParts.push(`${counts.synced} to sync`)
    if (counts.updated > 0) summaryParts.push(`${counts.updated} to update`)
    if (counts.locked > 0) summaryParts.push(`${counts.locked} lock updates`)
    if (counts.removed > 0) summaryParts.push(styled.red(`${counts.removed} to remove`))
    if (counts.errors > 0) summaryParts.push(styled.red(`${counts.errors} errors`))
    if (counts.alreadySynced > 0) summaryParts.push(`${counts.alreadySynced} unchanged`)
  } else {
    // Actual sync summary
    if (counts.cloned > 0) summaryParts.push(`${counts.cloned} cloned`)
    if (counts.synced > 0) summaryParts.push(`${counts.synced} synced`)
    if (counts.updated > 0) summaryParts.push(`${counts.updated} updated`)
    if (counts.locked > 0) summaryParts.push(`${counts.locked} lock updates`)
    if (counts.removed > 0) summaryParts.push(styled.red(`${counts.removed} removed`))
    if (counts.errors > 0) summaryParts.push(styled.red(`${counts.errors} errors`))
    if (counts.alreadySynced > 0) summaryParts.push(`${counts.alreadySynced} unchanged`)
  }

  if (summaryParts.length === 0) {
    summaryParts.push('no changes')
  }

  output.push(styled.dim(summaryParts.join(` ${symbols.dot} `)))

  // Generated files section
  if (generatedFiles && generatedFiles.length > 0) {
    output.push('')
    output.push(dryRun ? 'Would generate:' : 'Generated:')
    for (const file of generatedFiles) {
      const symbol = dryRun ? styled.dim('→') : styled.green(symbols.check)
      output.push(`  ${symbol} ${styled.bold(file)}`)
    }
  }

  // Nested megarepos hint (only if not using --deep and there are nested repos)
  if (nestedMegarepos.length > 0 && !deep) {
    output.push('')
    output.push(
      styled.dim(
        `Note: ${nestedMegarepos.length} member${nestedMegarepos.length > 1 ? 's' : ''} contain nested megarepos`,
      ),
    )
    output.push(styled.dim(`      Run 'mr sync --deep' to sync them`))
  }

  return output
}
