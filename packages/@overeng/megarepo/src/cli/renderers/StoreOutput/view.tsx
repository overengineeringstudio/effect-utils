/**
 * StoreOutput View
 *
 * React component for rendering all store command outputs.
 * Handles ls, status, fetch, gc, add, and error states.
 */

import type { Atom } from '@effect-atom/atom'
import React from 'react'

import { Box, Text, useTuiAtomValue, unicodeSymbols } from '@overeng/tui-react'

import type { StoreState, StoreGcResult, StoreWorktreeStatus, StoreGcWarning } from './schema.ts'

// Shorthand for commonly used symbols
const SYMBOLS = {
  check: unicodeSymbols.status.check,
  cross: unicodeSymbols.status.cross,
  warning: unicodeSymbols.status.warning,
  circle: unicodeSymbols.status.circle,
  dot: unicodeSymbols.status.dot,
  arrow: unicodeSymbols.arrows.right,
}

// =============================================================================
// Helpers
// =============================================================================

/** Format elapsed time */
function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.floor(ms / 1000)
  const remainingMs = ms % 1000
  if (seconds < 60)
    return remainingMs > 0 ? `${seconds}.${Math.floor(remainingMs / 100)}s` : `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSecs = seconds % 60
  return `${minutes}m ${remainingSecs}s`
}

// =============================================================================
// Main Component
// =============================================================================

export interface StoreViewProps {
  stateAtom: Atom.Atom<StoreState>
}

/**
 * StoreView - View for all store commands.
 *
 * Renders based on the _tag discriminator:
 * - Ls: list of repos
 * - Status: worktree status with issues
 * - Fetch: fetch results
 * - Gc: garbage collection results
 * - Add: add confirmation
 * - Error: error message
 */
export const StoreView = ({ stateAtom }: StoreViewProps) => {
  const state = useTuiAtomValue(stateAtom)

  switch (state._tag) {
    case 'Ls':
      return <StoreLsView basePath={state.basePath} repos={state.repos} />
    case 'Status':
      return (
        <StoreStatusView
          basePath={state.basePath}
          repoCount={state.repoCount}
          worktreeCount={state.worktreeCount}
          diskUsage={state.diskUsage}
          worktrees={state.worktrees}
        />
      )
    case 'Fetch':
      return (
        <StoreFetchView
          basePath={state.basePath}
          results={state.results}
          elapsedMs={state.elapsedMs}
        />
      )
    case 'Gc':
      return (
        <StoreGcView
          basePath={state.basePath}
          results={state.results}
          dryRun={state.dryRun}
          warning={state.warning}
          showForceHint={state.showForceHint}
        />
      )
    case 'Add':
      return (
        <StoreAddView
          source={state.source}
          ref={state.ref}
          commit={state.commit}
          path={state.path}
          alreadyExists={state.status === 'already_exists'}
        />
      )
    case 'Error':
      return <StoreErrorView error={state.error} message={state.message} source={state.source} />
  }
}

// =============================================================================
// Sub-Views
// =============================================================================

/** Header component shared by most views */
function StoreHeader({ basePath, title = 'store' }: { basePath: string; title?: string }) {
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      <Text dim> path</Text>
      <Text>: {basePath}</Text>
      <Text> </Text>
    </Box>
  )
}

/** Ls view - list repos */
function StoreLsView({
  basePath,
  repos,
}: {
  basePath: string
  repos: readonly { relativePath: string }[]
}) {
  return (
    <Box flexDirection="column">
      <StoreHeader basePath={basePath} />
      <Text dim>{'─'.repeat(40)}</Text>
      <Text> </Text>
      {repos.length === 0 ? (
        <Text dim>(empty)</Text>
      ) : (
        <>
          {repos.map((repo) => (
            <Box key={repo.relativePath} flexDirection="row">
              <Text color="green">{SYMBOLS.check}</Text>
              <Text> {repo.relativePath}</Text>
            </Box>
          ))}
          <Text> </Text>
          <Text dim>{repos.length} repositories</Text>
        </>
      )}
    </Box>
  )
}

/** Status view - show worktree status */
function StoreStatusView({
  basePath,
  repoCount,
  worktreeCount,
  diskUsage,
  worktrees,
}: {
  basePath: string
  repoCount: number
  worktreeCount: number
  diskUsage?: string | undefined
  worktrees: readonly StoreWorktreeStatus[]
}) {
  // Filter to only worktrees with issues
  const worktreesWithIssues = worktrees.filter((w) => w.issues.length > 0)

  // Count issues by severity
  const errorCount = worktrees.reduce(
    (acc, w) => acc + w.issues.filter((i) => i.severity === 'error').length,
    0,
  )
  const warningCount = worktrees.reduce(
    (acc, w) => acc + w.issues.filter((i) => i.severity === 'warning').length,
    0,
  )
  const infoCount = worktrees.reduce(
    (acc, w) => acc + w.issues.filter((i) => i.severity === 'info').length,
    0,
  )

  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text bold>Store: </Text>
          <Text>{basePath}</Text>
          {diskUsage && <Text dim> ({diskUsage})</Text>}
        </Box>
        <Text dim>
          {'  '}
          {repoCount} repo{repoCount !== 1 ? 's' : ''}, {worktreeCount} worktree
          {worktreeCount !== 1 ? 's' : ''}
        </Text>
        <Text> </Text>
      </Box>
      {worktreesWithIssues.length > 0 && (
        <>
          <Text bold>Issues:</Text>
          {worktreesWithIssues.map((worktree) => (
            <StoreStatusWorktreeRow
              key={`${worktree.repo}-${worktree.refType}-${worktree.ref}`}
              worktree={worktree}
            />
          ))}
          <Text> </Text>
        </>
      )}
      <StoreStatusSummary
        errorCount={errorCount}
        warningCount={warningCount}
        infoCount={infoCount}
      />
    </Box>
  )
}

/** Single worktree with issues */
function StoreStatusWorktreeRow({ worktree }: { worktree: StoreWorktreeStatus }) {
  // Get highest severity for the header
  const highestSeverity = worktree.issues.reduce<'error' | 'warning' | 'info'>((acc, issue) => {
    if (issue.severity === 'error') return 'error'
    if (issue.severity === 'warning' && acc !== 'error') return 'warning'
    return acc
  }, 'info')

  const getSymbol = (severity: 'error' | 'warning' | 'info') => {
    switch (severity) {
      case 'error':
        return <Text color="red">{SYMBOLS.cross}</Text>
      case 'warning':
        return <Text color="yellow">{SYMBOLS.warning}</Text>
      case 'info':
        return <Text dim>{SYMBOLS.circle}</Text>
    }
  }

  const getColor = (
    severity: 'error' | 'warning' | 'info',
  ): 'red' | 'yellow' | 'gray' | undefined => {
    switch (severity) {
      case 'error':
        return 'red'
      case 'warning':
        return 'yellow'
      case 'info':
        return 'gray'
    }
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        {getSymbol(highestSeverity)}
        <Text> </Text>
        <Text>{worktree.repo}</Text>
        <Text dim>/refs/{worktree.refType}/</Text>
        <Text bold>{worktree.ref}</Text>
      </Box>
      {worktree.issues.map((issue, i) => (
        <Box key={`${issue.type}-${i}`} flexDirection="row">
          <Text>{'    '}</Text>
          <Text color={getColor(issue.severity)}>{issue.type}</Text>
          <Text dim>: {issue.message}</Text>
        </Box>
      ))}
    </Box>
  )
}

/** Status summary */
function StoreStatusSummary({
  errorCount,
  warningCount,
  infoCount,
}: {
  errorCount: number
  warningCount: number
  infoCount: number
}) {
  const totalIssues = errorCount + warningCount + infoCount

  if (totalIssues === 0) {
    return (
      <Box flexDirection="row">
        <Text color="green">{SYMBOLS.check}</Text>
        <Text> All worktrees healthy</Text>
      </Box>
    )
  }

  const parts: React.ReactNode[] = []
  if (errorCount > 0) {
    parts.push(
      <Text key="errors" color="red">
        {errorCount} error{errorCount !== 1 ? 's' : ''}
      </Text>,
    )
  }
  if (warningCount > 0) {
    parts.push(
      <Text key="warnings" color="yellow">
        {warningCount} warning{warningCount !== 1 ? 's' : ''}
      </Text>,
    )
  }
  if (infoCount > 0) {
    parts.push(
      <Text key="info" dim>
        {infoCount} info
      </Text>,
    )
  }

  return (
    <Box flexDirection="row">
      {parts.map((part, i) => (
        <React.Fragment key={`part-${i}-${totalIssues}`}>
          {i > 0 && <Text dim> {SYMBOLS.dot} </Text>}
          {part}
        </React.Fragment>
      ))}
    </Box>
  )
}

/** Fetch view - show fetch results */
function StoreFetchView({
  basePath,
  results,
  elapsedMs,
}: {
  basePath: string
  results: readonly { path: string; status: 'fetched' | 'error'; message?: string | undefined }[]
  elapsedMs: number
}) {
  const fetchedCount = results.filter((r) => r.status === 'fetched').length
  const errorCount = results.filter((r) => r.status === 'error').length

  return (
    <Box flexDirection="column">
      <StoreHeader basePath={basePath} />
      <Text dim>{'─'.repeat(40)}</Text>
      <Text> </Text>
      {results.map((result) => (
        <Box key={result.path} flexDirection="row">
          {result.status === 'error' ? (
            <Text color="red">{SYMBOLS.cross}</Text>
          ) : (
            <Text color="green">{SYMBOLS.check}</Text>
          )}
          <Text> {result.path}</Text>
          {result.status === 'error' && result.message && <Text dim> ({result.message})</Text>}
        </Box>
      ))}
      <Text> </Text>
      <Box flexDirection="row">
        <Text dim>{fetchedCount} fetched</Text>
        {errorCount > 0 && (
          <>
            <Text dim> {SYMBOLS.dot} </Text>
            <Text color="red">
              {errorCount} error{errorCount > 1 ? 's' : ''}
            </Text>
          </>
        )}
        <Text dim>
          {' '}
          {SYMBOLS.dot} {formatElapsed(elapsedMs)}
        </Text>
      </Box>
    </Box>
  )
}

/** GC view - show garbage collection results */
function StoreGcView({
  basePath,
  results,
  dryRun,
  warning,
  showForceHint,
  maxInUseToShow = 5,
}: {
  basePath: string
  results: readonly StoreGcResult[]
  dryRun: boolean
  warning?: StoreGcWarning | undefined
  showForceHint: boolean
  maxInUseToShow?: number
}) {
  const removed = results.filter((r) => r.status === 'removed')
  const skippedDirty = results.filter((r) => r.status === 'skipped_dirty')
  const skippedInUse = results.filter((r) => r.status === 'skipped_in_use')
  const errors = results.filter((r) => r.status === 'error')

  // Determine which results to show
  const showInUse = skippedInUse.length <= maxInUseToShow

  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        <Text bold>store gc</Text>
        <Text dim> path</Text>
        <Text>: {basePath}</Text>
        {dryRun && <Text dim> mode: dry run</Text>}
        <Text> </Text>
      </Box>
      {warning && <StoreGcWarningRow warning={warning} />}
      <Text dim>{'─'.repeat(40)}</Text>
      <Text> </Text>
      {results.length === 0 ? (
        <Text dim>No worktrees found</Text>
      ) : (
        <>
          {removed.map((result) => (
            <StoreGcResultRow
              key={`${result.repo}-${result.ref}-removed`}
              result={result}
              dryRun={dryRun}
            />
          ))}
          {skippedDirty.map((result) => (
            <StoreGcResultRow
              key={`${result.repo}-${result.ref}-dirty`}
              result={result}
              dryRun={dryRun}
            />
          ))}
          {showInUse &&
            skippedInUse.map((result) => (
              <StoreGcResultRow
                key={`${result.repo}-${result.ref}-in-use`}
                result={result}
                dryRun={dryRun}
              />
            ))}
          {errors.map((result) => (
            <StoreGcResultRow
              key={`${result.repo}-${result.ref}-error`}
              result={result}
              dryRun={dryRun}
            />
          ))}
        </>
      )}
      <Text> </Text>
      <StoreGcSummary
        removed={removed.length}
        skippedDirty={skippedDirty.length}
        skippedInUse={skippedInUse.length}
        errors={errors.length}
        dryRun={dryRun}
      />
      {showForceHint && skippedDirty.length > 0 && (
        <Text dim>Use --force to remove dirty worktrees</Text>
      )}
    </Box>
  )
}

/** GC Warning component */
function StoreGcWarningRow({ warning }: { warning: StoreGcWarning }) {
  if (warning.type === 'not_in_megarepo') {
    return (
      <Box flexDirection="column">
        <Text dim>Not in a megarepo - all worktrees will be considered unused</Text>
        <Text> </Text>
      </Box>
    )
  }

  if (warning.type === 'only_current_megarepo') {
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text color="yellow">{SYMBOLS.warning}</Text>
          <Text color="yellow"> Only checking current megarepo for in-use worktrees</Text>
        </Box>
        <Text dim> Worktrees used by other megarepos may be removed</Text>
        <Text dim> Run from each megarepo to preserve its worktrees, or use --dry-run first</Text>
        <Text> </Text>
      </Box>
    )
  }

  // Custom warning
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color="yellow">{SYMBOLS.warning}</Text>
        <Text> {warning.message}</Text>
      </Box>
      <Text> </Text>
    </Box>
  )
}

/** GC Result line component */
function StoreGcResultRow({ result, dryRun }: { result: StoreGcResult; dryRun: boolean }) {
  const getSymbol = () => {
    switch (result.status) {
      case 'removed':
        return <Text color="green">{SYMBOLS.check}</Text>
      case 'error':
        return <Text color="red">{SYMBOLS.cross}</Text>
      case 'skipped_dirty':
        return <Text color="yellow">{SYMBOLS.circle}</Text>
      case 'skipped_in_use':
        return <Text dim>{SYMBOLS.check}</Text>
    }
  }

  const getStatusText = () => {
    switch (result.status) {
      case 'removed':
        return <Text dim> ({dryRun ? 'would remove' : 'removed'})</Text>
      case 'skipped_dirty':
        return <Text dim> ({result.message ?? 'dirty'})</Text>
      case 'skipped_in_use':
        return <Text dim> (in use)</Text>
      case 'error':
        return <Text color="red"> (error: {result.message})</Text>
    }
  }

  const isDim = result.status === 'skipped_in_use'

  return (
    <Box flexDirection="row">
      {getSymbol()}
      {isDim ? (
        <Text dim>
          {' '}
          {result.repo}refs/{result.ref}{' '}
        </Text>
      ) : (
        <Text>
          {' '}
          {result.repo}refs/{result.ref}{' '}
        </Text>
      )}
      {getStatusText()}
    </Box>
  )
}

/** GC Summary component */
function StoreGcSummary({
  removed,
  skippedDirty,
  skippedInUse,
  errors,
  dryRun,
}: {
  removed: number
  skippedDirty: number
  skippedInUse: number
  errors: number
  dryRun: boolean
}) {
  const parts: Array<{ key: string; element: React.ReactNode }> = []

  if (removed > 0) {
    parts.push({
      key: 'removed',
      element: (
        <Text>
          {removed} {dryRun ? 'would be removed' : 'removed'}
        </Text>
      ),
    })
  }
  if (skippedDirty > 0) {
    parts.push({
      key: 'dirty',
      element: <Text>{skippedDirty} skipped (dirty)</Text>,
    })
  }
  if (skippedInUse > 0) {
    parts.push({
      key: 'in-use',
      element: <Text>{skippedInUse} in use</Text>,
    })
  }
  if (errors > 0) {
    parts.push({
      key: 'errors',
      element: (
        <Text color="red">
          {errors} error{errors > 1 ? 's' : ''}
        </Text>
      ),
    })
  }

  if (parts.length === 0) {
    return <Text dim>Nothing to clean up</Text>
  }

  return (
    <Box flexDirection="row">
      <Text dim>
        {parts.map((part, i) => (
          <React.Fragment key={part.key}>
            {i > 0 && ` ${SYMBOLS.dot} `}
            {part.element}
          </React.Fragment>
        ))}
      </Text>
    </Box>
  )
}

/** Add view - show add result */
function StoreAddView({
  source,
  ref,
  commit,
  path,
  alreadyExists,
}: {
  source: string
  ref: string
  commit?: string | undefined
  path: string
  alreadyExists: boolean
}) {
  const status = alreadyExists ? 'already in store' : 'added to store'

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        {alreadyExists ? (
          <Text dim>{SYMBOLS.check}</Text>
        ) : (
          <Text color="green">{SYMBOLS.check}</Text>
        )}
        <Text> </Text>
        <Text bold>{source}</Text>
        <Text dim> ({status})</Text>
      </Box>
      <Text dim> ref: {ref}</Text>
      {commit && <Text dim> commit: {commit.slice(0, 7)}</Text>}
      <Text dim> path: {path}</Text>
    </Box>
  )
}

/** Error view - show error message */
function StoreErrorView({
  error: _error,
  message,
  source: _source,
}: {
  error: string
  message: string
  source?: string | undefined
}) {
  return (
    <Box flexDirection="row">
      <Text color="red">{SYMBOLS.cross}</Text>
      <Text> {message}</Text>
    </Box>
  )
}
