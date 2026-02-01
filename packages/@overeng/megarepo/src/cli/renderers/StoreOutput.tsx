/**
 * React components for rendering store command outputs.
 *
 * These components provide consistent rendering for store ls, fetch, and gc commands.
 */

import React from 'react'

import { kv, separator } from '@overeng/cli-ui'
import { Box, Text } from '@overeng/tui-react'

// =============================================================================
// Types
// =============================================================================

/** Repository info from store ls */
export type StoreRepo = {
  relativePath: string
}

/** Fetch result for a single repo */
export type StoreFetchResult = {
  path: string
  status: 'fetched' | 'error'
  message?: string | undefined
}

/** GC result for a single worktree */
export type StoreGcResult = {
  repo: string
  ref: string
  path: string
  status: 'removed' | 'skipped_dirty' | 'skipped_in_use' | 'error'
  message?: string | undefined
}

/** Issue type for store status */
export type StoreWorktreeIssueType =
  | 'dirty'
  | 'unpushed'
  | 'ref_mismatch'
  | 'missing_bare'
  | 'broken_worktree'
  | 'orphaned'

/** Issue severity */
export type StoreIssueSeverity = 'error' | 'warning' | 'info'

/** A single issue found in a worktree */
export type StoreWorktreeIssue = {
  type: StoreWorktreeIssueType
  severity: StoreIssueSeverity
  message: string
}

/** Status result for a single worktree */
export type StoreWorktreeStatus = {
  repo: string
  ref: string
  refType: 'heads' | 'tags' | 'commits'
  path: string
  issues: readonly StoreWorktreeIssue[]
}

// =============================================================================
// Symbols
// =============================================================================

const symbols = {
  check: '\u2713',
  cross: '\u2717',
  warning: '\u26a0',
  circle: '\u25cb',
  dot: '\u00b7',
}

// =============================================================================
// Store Header Component
// =============================================================================

export type StoreHeaderProps = {
  basePath: string
}

export const StoreHeader = ({ basePath }: StoreHeaderProps) => (
  <Box flexDirection="column">
    <Text bold>store</Text>
    <Text>
      {kv({ key: 'path', value: basePath, options: { keyStyle: (k: string) => `  ${k}` } })}
    </Text>
    <Text> </Text>
  </Box>
)

// =============================================================================
// Store List Output
// =============================================================================

export type StoreListOutputProps = {
  basePath: string
  repos: readonly StoreRepo[]
}

export const StoreListOutput = ({ basePath, repos }: StoreListOutputProps) => (
  <Box flexDirection="column">
    <StoreHeader basePath={basePath} />
    <Text>{separator()}</Text>
    <Text> </Text>
    {repos.length === 0 ? (
      <Text dim>(empty)</Text>
    ) : (
      <>
        {repos.map((repo) => (
          <Box key={repo.relativePath} flexDirection="row">
            <Text color="green">{symbols.check}</Text>
            <Text> {repo.relativePath}</Text>
          </Box>
        ))}
        <Text> </Text>
        <Text dim>{repos.length} repositories</Text>
      </>
    )}
  </Box>
)

// =============================================================================
// Store Fetch Output
// =============================================================================

export type StoreFetchOutputProps = {
  basePath: string
  results: readonly StoreFetchResult[]
  elapsedMs: number
}

/** Format elapsed time */
const formatElapsed = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.floor(ms / 1000)
  const remainingMs = ms % 1000
  if (seconds < 60)
    return remainingMs > 0 ? `${seconds}.${Math.floor(remainingMs / 100)}s` : `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSecs = seconds % 60
  return `${minutes}m ${remainingSecs}s`
}

export const StoreFetchOutput = ({ basePath, results, elapsedMs }: StoreFetchOutputProps) => {
  const fetchedCount = results.filter((r) => r.status === 'fetched').length
  const errorCount = results.filter((r) => r.status === 'error').length

  return (
    <Box flexDirection="column">
      <StoreHeader basePath={basePath} />
      <Text>{separator()}</Text>
      <Text> </Text>
      {results.map((result) => (
        <Box key={result.path} flexDirection="row">
          {result.status === 'error' ? (
            <Text color="red">{symbols.cross}</Text>
          ) : (
            <Text color="green">{symbols.check}</Text>
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
            <Text dim> {symbols.dot} </Text>
            <Text color="red">
              {errorCount} error{errorCount > 1 ? 's' : ''}
            </Text>
          </>
        )}
        <Text dim>
          {' '}
          {symbols.dot} {formatElapsed(elapsedMs)}
        </Text>
      </Box>
    </Box>
  )
}

// =============================================================================
// Store GC Output
// =============================================================================

/** Warning type for GC command */
export type StoreGcWarningType = 'not_in_megarepo' | 'only_current_megarepo' | 'custom'

export type StoreGcOutputProps = {
  basePath: string
  results: readonly StoreGcResult[]
  dryRun: boolean
  /** Warning to show before results */
  warning?:
    | {
        type: StoreGcWarningType
        message?: string | undefined
      }
    | undefined
  /** Whether to show the force hint when there are dirty worktrees */
  showForceHint?: boolean | undefined
  /** Max number of in-use worktrees to show individually (default: 5) */
  maxInUseToShow?: number | undefined
}

/** GC Header component */
const StoreGcHeader = ({ basePath, dryRun }: { basePath: string; dryRun: boolean }) => (
  <Box flexDirection="column">
    <Text bold>store gc</Text>
    <Text>
      {kv({ key: 'path', value: basePath, options: { keyStyle: (k: string) => `  ${k}` } })}
    </Text>
    {dryRun && <Text dim> mode: dry run</Text>}
    <Text> </Text>
  </Box>
)

/** GC Warning component */
const StoreGcWarning = ({ warning }: { warning: NonNullable<StoreGcOutputProps['warning']> }) => {
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
          <Text color="yellow">{symbols.warning}</Text>
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
        <Text color="yellow">{symbols.warning}</Text>
        <Text> {warning.message}</Text>
      </Box>
      <Text> </Text>
    </Box>
  )
}

/** GC Result line component */
const StoreGcResultLine = ({ result, dryRun }: { result: StoreGcResult; dryRun: boolean }) => {
  const getSymbol = () => {
    switch (result.status) {
      case 'removed':
        return <Text color="green">{symbols.check}</Text>
      case 'error':
        return <Text color="red">{symbols.cross}</Text>
      case 'skipped_dirty':
        return <Text color="yellow">{symbols.circle}</Text>
      case 'skipped_in_use':
        return <Text dim>{symbols.check}</Text>
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
const StoreGcSummary = ({
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
}) => {
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
            {i > 0 && ` ${symbols.dot} `}
            {part.element}
          </React.Fragment>
        ))}
      </Text>
    </Box>
  )
}

export const StoreGcOutput = ({
  basePath,
  results,
  dryRun,
  warning,
  showForceHint = true,
  maxInUseToShow = 5,
}: StoreGcOutputProps) => {
  const removed = results.filter((r) => r.status === 'removed')
  const skippedDirty = results.filter((r) => r.status === 'skipped_dirty')
  const skippedInUse = results.filter((r) => r.status === 'skipped_in_use')
  const errors = results.filter((r) => r.status === 'error')

  // Determine which results to show
  const showInUse = skippedInUse.length <= maxInUseToShow

  return (
    <Box flexDirection="column">
      <StoreGcHeader basePath={basePath} dryRun={dryRun} />
      {warning && <StoreGcWarning warning={warning} />}
      <Text>{separator()}</Text>
      <Text> </Text>
      {results.length === 0 ? (
        <Text dim>No worktrees found</Text>
      ) : (
        <>
          {/* Removed worktrees */}
          {removed.map((result) => (
            <StoreGcResultLine
              key={`${result.repo}-${result.ref}-removed`}
              result={result}
              dryRun={dryRun}
            />
          ))}
          {/* Skipped dirty worktrees */}
          {skippedDirty.map((result) => (
            <StoreGcResultLine
              key={`${result.repo}-${result.ref}-dirty`}
              result={result}
              dryRun={dryRun}
            />
          ))}
          {/* Skipped in-use worktrees (only if few) */}
          {showInUse &&
            skippedInUse.map((result) => (
              <StoreGcResultLine
                key={`${result.repo}-${result.ref}-in-use`}
                result={result}
                dryRun={dryRun}
              />
            ))}
          {/* Errors */}
          {errors.map((result) => (
            <StoreGcResultLine
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

// =============================================================================
// Store Add Output
// =============================================================================

/** Error types for store add command */
export type StoreAddErrorType = 'invalid_source' | 'local_path' | 'no_url'

export type StoreAddErrorProps = {
  type: StoreAddErrorType
  source?: string | undefined
}

/** Error message for store add failures */
export const StoreAddError = ({ type, source }: StoreAddErrorProps) => {
  const getMessage = () => {
    switch (type) {
      case 'invalid_source':
        return `Invalid source string: ${source}`
      case 'local_path':
        return 'Cannot add local path to store'
      case 'no_url':
        return 'Cannot determine clone URL'
    }
  }

  return (
    <Box flexDirection="row">
      <Text color="red">{symbols.cross}</Text>
      <Text> {getMessage()}</Text>
    </Box>
  )
}

export type StoreAddProgressProps = {
  type: 'cloning' | 'creating_worktree'
  source?: string | undefined
  ref?: string | undefined
}

/** Progress message for store add operations */
export const StoreAddProgress = ({ type, source, ref }: StoreAddProgressProps) => {
  const getMessage = () => {
    switch (type) {
      case 'cloning':
        return `Cloning ${source}...`
      case 'creating_worktree':
        return `Creating worktree at ${ref}...`
    }
  }

  return (
    <Box flexDirection="row">
      <Text dim>{'\u2192'}</Text>
      <Text> {getMessage()}</Text>
    </Box>
  )
}

export type StoreAddSuccessProps = {
  source: string
  ref: string
  commit?: string | undefined
  path: string
  alreadyExists: boolean
}

/** Success message for store add completion */
export const StoreAddSuccess = ({
  source,
  ref,
  commit,
  path,
  alreadyExists,
}: StoreAddSuccessProps) => {
  const status = alreadyExists ? 'already in store' : 'added to store'

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        {alreadyExists ? (
          <Text dim>{symbols.check}</Text>
        ) : (
          <Text color="green">{symbols.check}</Text>
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

// =============================================================================
// Store Status Output
// =============================================================================

export type StoreStatusOutputProps = {
  basePath: string
  repoCount: number
  worktreeCount: number
  diskUsage?: string | undefined
  worktrees: readonly StoreWorktreeStatus[]
}

/** Get symbol for issue severity */
const getIssueSeveritySymbol = (severity: StoreIssueSeverity) => {
  switch (severity) {
    case 'error':
      return <Text color="red">{symbols.cross}</Text>
    case 'warning':
      return <Text color="yellow">{symbols.warning}</Text>
    case 'info':
      return <Text dim>{symbols.circle}</Text>
  }
}

/** Get color for issue type */
const getIssueColor = (
  severity: StoreIssueSeverity,
): 'red' | 'yellow' | 'gray' | 'green' | 'blue' | 'cyan' | 'magenta' | 'white' | undefined => {
  switch (severity) {
    case 'error':
      return 'red'
    case 'warning':
      return 'yellow'
    case 'info':
      return 'gray'
  }
}

/** Single worktree with issues */
const StoreStatusWorktree = ({ worktree }: { worktree: StoreWorktreeStatus }) => {
  // Get highest severity for the header
  const highestSeverity = worktree.issues.reduce<StoreIssueSeverity>((acc, issue) => {
    if (issue.severity === 'error') return 'error'
    if (issue.severity === 'warning' && acc !== 'error') return 'warning'
    return acc
  }, 'info' as StoreIssueSeverity)

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        {getIssueSeveritySymbol(highestSeverity)}
        <Text> </Text>
        <Text>{worktree.repo}</Text>
        <Text dim>/refs/{worktree.refType}/</Text>
        <Text bold>{worktree.ref}</Text>
      </Box>
      {worktree.issues.map((issue, i) => (
        <Box key={`${issue.type}-${i}`} flexDirection="row">
          <Text>{'    '}</Text>
          <Text color={getIssueColor(issue.severity)}>{issue.type}</Text>
          <Text dim>: {issue.message}</Text>
        </Box>
      ))}
    </Box>
  )
}

/** Store status header */
const StoreStatusHeader = ({
  basePath,
  diskUsage,
  repoCount,
  worktreeCount,
}: {
  basePath: string
  diskUsage: string | undefined
  repoCount: number
  worktreeCount: number
}) => (
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
)

/** Store status summary */
const StoreStatusSummary = ({
  errorCount,
  warningCount,
  infoCount,
}: {
  errorCount: number
  warningCount: number
  infoCount: number
}) => {
  const totalIssues = errorCount + warningCount + infoCount

  if (totalIssues === 0) {
    return (
      <Box flexDirection="row">
        <Text color="green">{symbols.check}</Text>
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
          {i > 0 && <Text dim> {symbols.dot} </Text>}
          {part}
        </React.Fragment>
      ))}
    </Box>
  )
}

export const StoreStatusOutput = ({
  basePath,
  repoCount,
  worktreeCount,
  diskUsage,
  worktrees,
}: StoreStatusOutputProps) => {
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
      <StoreStatusHeader
        basePath={basePath}
        diskUsage={diskUsage}
        repoCount={repoCount}
        worktreeCount={worktreeCount}
      />
      {worktreesWithIssues.length > 0 && (
        <>
          <Text bold>Issues:</Text>
          {worktreesWithIssues.map((worktree) => (
            <StoreStatusWorktree
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
