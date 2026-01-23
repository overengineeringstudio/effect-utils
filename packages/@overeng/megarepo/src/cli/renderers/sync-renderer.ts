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
  readonly status: 'cloned' | 'synced' | 'already_synced' | 'skipped' | 'error'
  readonly message?: string | undefined
  /** Commit that was synced to (for display) */
  readonly commit?: string | undefined
  /** Ref that was synced to */
  readonly ref?: string | undefined
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
  alreadySynced: number
  skipped: number
  errors: number
} => {
  let cloned = 0
  let synced = 0
  let alreadySynced = 0
  let skipped = 0
  let errors = 0

  for (const r of results) {
    switch (r.status) {
      case 'cloned':
        cloned++
        break
      case 'synced':
        synced++
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
    }
  }

  return { cloned, synced, alreadySynced, skipped, errors }
}

/** Format status text for a result */
const formatStatusText = (result: MemberSyncResult): string => {
  switch (result.status) {
    case 'cloned':
      return 'cloned'
    case 'synced':
      return 'synced'
    case 'already_synced':
      return 'already synced'
    case 'skipped':
      return result.message ? `skipped: ${result.message}` : 'skipped'
    case 'error':
      return result.message ? `error: ${result.message}` : 'error'
  }
}

/** Get status symbol for a result */
const getStatusSymbol = (result: MemberSyncResult): string => {
  switch (result.status) {
    case 'cloned':
    case 'synced':
      return styled.green(symbols.check)
    case 'already_synced':
      return styled.dim(symbols.check)
    case 'skipped':
      return styled.yellow(symbols.circle)
    case 'error':
      return styled.red(symbols.cross)
  }
}

// =============================================================================
// Main Renderer
// =============================================================================

/** Render sync output */
export const renderSync = ({
  name,
  root,
  results,
  nestedMegarepos,
  deep,
  dryRun,
  frozen,
}: SyncRenderInput): string[] => {
  const output: string[] = []

  // Header
  output.push(styled.bold(name))
  output.push(kv('root', root, { keyStyle: (k) => styled.dim(`  ${k}`) }))

  // Mode indicators
  const modeIndicators: string[] = []
  if (dryRun) modeIndicators.push('dry run')
  if (frozen) modeIndicators.push('frozen')
  if (modeIndicators.length > 0) {
    output.push(styled.dim(`  mode: ${modeIndicators.join(', ')}`))
  }
  output.push('')

  // Member results
  const counts = countResults(results)
  const hasChanges = counts.cloned > 0 || counts.synced > 0 || counts.errors > 0

  if (dryRun && !hasChanges && counts.errors === 0) {
    // Nothing would change
    output.push(`${styled.green(symbols.check)} ${styled.dim('workspace is up to date')}`)
  } else {
    // Show each member result
    // Group by status for cleaner output
    const cloned = results.filter((r) => r.status === 'cloned')
    const synced = results.filter((r) => r.status === 'synced')
    const errors = results.filter((r) => r.status === 'error')
    const skipped = results.filter((r) => r.status === 'skipped')
    const alreadySynced = results.filter((r) => r.status === 'already_synced')

    // Show changes first (cloned, synced)
    for (const r of cloned) {
      const refInfo = r.ref ? ` ${styled.dim(`(${r.ref})`)}` : ''
      output.push(`${getStatusSymbol(r)} ${styled.bold(r.name)} ${styled.green('cloned')}${refInfo}`)
    }

    for (const r of synced) {
      const refInfo = r.ref ? ` ${styled.dim(`(${r.ref})`)}` : ''
      output.push(`${getStatusSymbol(r)} ${styled.bold(r.name)} ${styled.green('synced')}${refInfo}`)
    }

    // Show errors
    for (const r of errors) {
      output.push(
        `${getStatusSymbol(r)} ${styled.bold(r.name)} ${styled.red(formatStatusText(r))}`,
      )
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
    if (counts.errors > 0) summaryParts.push(styled.red(`${counts.errors} errors`))
    if (counts.alreadySynced > 0) summaryParts.push(`${counts.alreadySynced} unchanged`)
  } else {
    // Actual sync summary
    if (counts.cloned > 0) summaryParts.push(`${counts.cloned} cloned`)
    if (counts.synced > 0) summaryParts.push(`${counts.synced} synced`)
    if (counts.errors > 0) summaryParts.push(styled.red(`${counts.errors} errors`))
    if (counts.alreadySynced > 0) summaryParts.push(`${counts.alreadySynced} unchanged`)
  }

  if (summaryParts.length === 0) {
    summaryParts.push('no changes')
  }

  output.push(styled.dim(summaryParts.join(` ${symbols.dot} `)))

  // Nested megarepos hint (only if not using --deep and there are nested repos)
  if (nestedMegarepos.length > 0 && !deep) {
    output.push('')
    output.push(
      styled.dim(`Note: ${nestedMegarepos.length} member${nestedMegarepos.length > 1 ? 's' : ''} contain nested megarepos`),
    )
    output.push(styled.dim(`      Run 'mr sync --deep' to sync them`))
  }

  return output
}
