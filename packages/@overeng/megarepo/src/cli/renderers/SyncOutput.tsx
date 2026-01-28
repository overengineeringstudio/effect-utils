/**
 * React component for rendering sync output.
 *
 * This is a 1:1 port of sync-renderer.ts to React components using @overeng/tui-react.
 * It can be used in Storybook for previewing and in the actual CLI via TuiRenderer.
 */

import React from 'react'
import { Box, Text, type BoxProps } from '@overeng/tui-react'

// =============================================================================
// Types (matching sync-renderer.ts)
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
export type SyncOutputProps = {
  /** Workspace name */
  name: string
  /** Workspace root path */
  root: string
  /** Sync results for each member */
  results: readonly MemberSyncResult[]
  /** Members that are themselves megarepos */
  nestedMegarepos?: readonly string[]
  /** Whether --deep flag was used */
  deep?: boolean
  /** Whether --dry-run flag was used */
  dryRun?: boolean
  /** Whether --frozen flag was used */
  frozen?: boolean
  /** Whether --pull flag was used */
  pull?: boolean
  /** List of generated file paths */
  generatedFiles?: readonly string[]
}

// =============================================================================
// Symbols
// =============================================================================

const symbols = {
  check: '\u2713',  // ✓
  cross: '\u2717',  // ✗
  circle: '\u25cb', // ○
  dot: '\u00b7',    // ·
}

// =============================================================================
// Helpers
// =============================================================================

/** Count sync results by status */
const countResults = (results: readonly MemberSyncResult[]) => {
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
      case 'cloned': cloned++; break
      case 'synced': synced++; break
      case 'updated': updated++; break
      case 'locked': locked++; break
      case 'already_synced': alreadySynced++; break
      case 'skipped': skipped++; break
      case 'error': errors++; break
      case 'removed': removed++; break
    }
  }

  return { cloned, synced, updated, locked, alreadySynced, skipped, errors, removed }
}

/** Format status text for a result */
const formatStatusText = (result: MemberSyncResult): string => {
  switch (result.status) {
    case 'cloned': return 'cloned'
    case 'synced': return 'synced'
    case 'updated': return 'updated'
    case 'locked': return 'lock updated'
    case 'already_synced': return 'already synced'
    case 'skipped': return result.message ? `skipped: ${result.message}` : 'skipped'
    case 'error': return result.message ? `error: ${result.message}` : 'error'
    case 'removed': return 'removed'
  }
}

// =============================================================================
// Sub-components
// =============================================================================

/** Status symbol component */
const StatusSymbol = ({ result }: { result: MemberSyncResult }) => {
  switch (result.status) {
    case 'cloned':
    case 'synced':
    case 'updated':
      return <Text color="green">{symbols.check}</Text>
    case 'locked':
      return <Text color="cyan">{symbols.check}</Text>
    case 'already_synced':
      return <Text dim>{symbols.check}</Text>
    case 'skipped':
      return <Text color="yellow">{symbols.circle}</Text>
    case 'error':
    case 'removed':
      return <Text color="red">{symbols.cross}</Text>
  }
}

/** Format commit transition (e.g., "abc1234 → def5678") */
const CommitTransition = ({ result }: { result: MemberSyncResult }) => {
  if (result.previousCommit && result.commit) {
    const prev = result.previousCommit.slice(0, 7)
    const curr = result.commit.slice(0, 7)
    return <Text dim>{prev} → {curr}</Text>
  }
  if (result.commit) {
    return <Text dim>{result.commit.slice(0, 7)}</Text>
  }
  return null
}

/** Header component */
const Header = ({ name, root, modes }: { name: string; root: string; modes: string[] }) => (
  <Box>
    <Text bold>{name}</Text>
    <Box flexDirection="row">
      <Text dim>{'  root: '}</Text>
      <Text>{root}</Text>
    </Box>
    {modes.length > 0 && (
      <Text dim>{'  mode: '}{modes.join(', ')}</Text>
    )}
  </Box>
)

/** Result line for cloned members */
const ClonedLine = ({ result }: { result: MemberSyncResult }) => {
  const refInfo = result.ref ? ` (${result.ref})` : ''
  return (
    <Box flexDirection="row">
      <StatusSymbol result={result} />
      <Text> </Text>
      <Text bold>{result.name}</Text>
      <Text> </Text>
      <Text color="green">cloned</Text>
      {result.ref && <Text dim>{refInfo}</Text>}
    </Box>
  )
}

/** Result line for synced members */
const SyncedLine = ({ result }: { result: MemberSyncResult }) => {
  const refInfo = result.ref ? ` (${result.ref})` : ''
  return (
    <Box flexDirection="row">
      <StatusSymbol result={result} />
      <Text> </Text>
      <Text bold>{result.name}</Text>
      <Text> </Text>
      <Text color="green">synced</Text>
      {result.ref && <Text dim>{refInfo}</Text>}
    </Box>
  )
}

/** Result line for updated members */
const UpdatedLine = ({ result }: { result: MemberSyncResult }) => (
  <Box flexDirection="row">
    <StatusSymbol result={result} />
    <Text> </Text>
    <Text bold>{result.name}</Text>
    <Text> </Text>
    <Text color="green">updated</Text>
    <Text> </Text>
    <CommitTransition result={result} />
  </Box>
)

/** Result line for locked members */
const LockedLine = ({ result }: { result: MemberSyncResult }) => (
  <Box flexDirection="row">
    <StatusSymbol result={result} />
    <Text> </Text>
    <Text bold>{result.name}</Text>
    <Text> </Text>
    <Text color="cyan">lock updated</Text>
    <Text> </Text>
    <CommitTransition result={result} />
  </Box>
)

/** Result line for removed members */
const RemovedLine = ({ result, dryRun }: { result: MemberSyncResult; dryRun: boolean }) => {
  const actionText = dryRun ? 'would remove' : 'removed'
  return (
    <Box flexDirection="row">
      <StatusSymbol result={result} />
      <Text> </Text>
      <Text bold>{result.name}</Text>
      <Text> </Text>
      <Text color="red">{actionText}</Text>
      {result.message && <Text dim> (-&gt; {result.message})</Text>}
    </Box>
  )
}

/** Result line for error members */
const ErrorLine = ({ result }: { result: MemberSyncResult }) => (
  <Box flexDirection="row">
    <StatusSymbol result={result} />
    <Text> </Text>
    <Text bold>{result.name}</Text>
    <Text> </Text>
    <Text color="red">{formatStatusText(result)}</Text>
  </Box>
)

/** Result line for skipped members */
const SkippedLine = ({ result }: { result: MemberSyncResult }) => (
  <Box flexDirection="row">
    <StatusSymbol result={result} />
    <Text> </Text>
    <Text bold>{result.name}</Text>
    <Text> </Text>
    <Text color="yellow">{formatStatusText(result)}</Text>
  </Box>
)

/** Result line for already synced members */
const AlreadySyncedLine = ({ result }: { result: MemberSyncResult }) => (
  <Box flexDirection="row">
    <StatusSymbol result={result} />
    <Text> </Text>
    <Text bold>{result.name}</Text>
    <Text> </Text>
    <Text dim>already synced</Text>
  </Box>
)

/** Separator line */
const Separator = () => (
  <Text dim>{'─'.repeat(40)}</Text>
)

/** Summary section */
/** Summary part type with key */
type SummaryPart = {
  key: string
  element: React.ReactNode
}

const Summary = ({ results, dryRun }: { results: readonly MemberSyncResult[]; dryRun: boolean }) => {
  const counts = countResults(results)
  const parts: SummaryPart[] = []

  if (dryRun) {
    if (counts.cloned > 0) parts.push({ key: 'cloned', element: <Text dim>{counts.cloned} to clone</Text> })
    if (counts.synced > 0) parts.push({ key: 'synced', element: <Text dim>{counts.synced} to sync</Text> })
    if (counts.updated > 0) parts.push({ key: 'updated', element: <Text dim>{counts.updated} to update</Text> })
    if (counts.locked > 0) parts.push({ key: 'locked', element: <Text dim>{counts.locked} lock updates</Text> })
    if (counts.removed > 0) parts.push({ key: 'removed', element: <Text color="red">{counts.removed} to remove</Text> })
    if (counts.errors > 0) parts.push({ key: 'errors', element: <Text color="red">{counts.errors} errors</Text> })
    if (counts.alreadySynced > 0) parts.push({ key: 'unchanged', element: <Text dim>{counts.alreadySynced} unchanged</Text> })
  } else {
    if (counts.cloned > 0) parts.push({ key: 'cloned', element: <Text dim>{counts.cloned} cloned</Text> })
    if (counts.synced > 0) parts.push({ key: 'synced', element: <Text dim>{counts.synced} synced</Text> })
    if (counts.updated > 0) parts.push({ key: 'updated', element: <Text dim>{counts.updated} updated</Text> })
    if (counts.locked > 0) parts.push({ key: 'locked', element: <Text dim>{counts.locked} lock updates</Text> })
    if (counts.removed > 0) parts.push({ key: 'removed', element: <Text color="red">{counts.removed} removed</Text> })
    if (counts.errors > 0) parts.push({ key: 'errors', element: <Text color="red">{counts.errors} errors</Text> })
    if (counts.alreadySynced > 0) parts.push({ key: 'unchanged', element: <Text dim>{counts.alreadySynced} unchanged</Text> })
  }

  if (parts.length === 0) {
    parts.push({ key: 'no-changes', element: <Text dim>no changes</Text> })
  }

  return (
    <Box flexDirection="row">
      {parts.map((part, i) => (
        <React.Fragment key={part.key}>
          {i > 0 && <Text dim> {symbols.dot} </Text>}
          {part.element}
        </React.Fragment>
      ))}
    </Box>
  )
}

/** Generated files section */
const GeneratedFiles = ({ files, dryRun }: { files: readonly string[]; dryRun: boolean }) => (
  <Box paddingTop={1}>
    <Text>{dryRun ? 'Would generate:' : 'Generated:'}</Text>
    {files.map((file) => (
      <Box key={file} flexDirection="row">
        <Text>  </Text>
        {dryRun ? <Text dim>→</Text> : <Text color="green">{symbols.check}</Text>}
        <Text> </Text>
        <Text bold>{file}</Text>
      </Box>
    ))}
  </Box>
)

/** Nested megarepos hint */
const NestedMegareposHint = ({ count }: { count: number }) => (
  <Box paddingTop={1}>
    <Text dim>
      Note: {count} member{count > 1 ? 's' : ''} contain nested megarepos
    </Text>
    <Text dim>      Run 'mr sync --deep' to sync them</Text>
  </Box>
)

// =============================================================================
// Main Component
// =============================================================================

/**
 * React component that renders sync output matching sync-renderer.ts 1:1.
 */
export const SyncOutput = ({
  name,
  root,
  results,
  nestedMegarepos = [],
  deep = false,
  dryRun = false,
  frozen = false,
  pull = false,
  generatedFiles = [],
}: SyncOutputProps) => {
  // Build mode indicators
  const modes: string[] = []
  if (dryRun) modes.push('dry run')
  if (frozen) modes.push('frozen')
  if (pull) modes.push('pull')

  // Count results
  const counts = countResults(results)
  const hasChanges =
    counts.cloned > 0 ||
    counts.synced > 0 ||
    counts.updated > 0 ||
    counts.locked > 0 ||
    counts.removed > 0 ||
    counts.errors > 0

  // Group results by status
  const cloned = results.filter((r) => r.status === 'cloned')
  const synced = results.filter((r) => r.status === 'synced')
  const updated = results.filter((r) => r.status === 'updated')
  const locked = results.filter((r) => r.status === 'locked')
  const removed = results.filter((r) => r.status === 'removed')
  const errors = results.filter((r) => r.status === 'error')
  const skipped = results.filter((r) => r.status === 'skipped')
  const alreadySynced = results.filter((r) => r.status === 'already_synced')

  return (
    <Box>
      {/* Header */}
      <Header name={name} root={root} modes={modes} />

      {/* Empty line after header */}
      <Text> </Text>

      {/* Results */}
      {dryRun && !hasChanges && counts.errors === 0 ? (
        // Nothing would change
        <Box flexDirection="row">
          <Text color="green">{symbols.check}</Text>
          <Text dim> workspace is up to date</Text>
        </Box>
      ) : (
        <>
          {/* Cloned */}
          {cloned.map((r) => <ClonedLine key={r.name} result={r} />)}

          {/* Synced */}
          {synced.map((r) => <SyncedLine key={r.name} result={r} />)}

          {/* Updated */}
          {updated.map((r) => <UpdatedLine key={r.name} result={r} />)}

          {/* Locked */}
          {locked.map((r) => <LockedLine key={r.name} result={r} />)}

          {/* Removed */}
          {removed.map((r) => <RemovedLine key={r.name} result={r} dryRun={dryRun} />)}

          {/* Errors */}
          {errors.map((r) => <ErrorLine key={r.name} result={r} />)}

          {/* Skipped */}
          {skipped.map((r) => <SkippedLine key={r.name} result={r} />)}

          {/* Already synced */}
          {alreadySynced.length > 0 && (
            alreadySynced.length <= 5 || hasChanges ? (
              // Show individually
              alreadySynced.map((r) => <AlreadySyncedLine key={r.name} result={r} />)
            ) : (
              // Compact display
              <Box flexDirection="row">
                <Text dim>{symbols.check} {alreadySynced.length} members already synced</Text>
              </Box>
            )
          )}
        </>
      )}

      {/* Separator and summary */}
      <Text> </Text>
      <Separator />
      <Summary results={results} dryRun={dryRun} />

      {/* Generated files */}
      {generatedFiles.length > 0 && (
        <GeneratedFiles files={generatedFiles} dryRun={dryRun} />
      )}

      {/* Nested megarepos hint */}
      {nestedMegarepos.length > 0 && !deep && (
        <NestedMegareposHint count={nestedMegarepos.length} />
      )}
    </Box>
  )
}


