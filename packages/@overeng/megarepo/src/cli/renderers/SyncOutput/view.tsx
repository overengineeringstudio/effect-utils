/**
 * SyncOutput View
 *
 * Unified view component for sync command.
 * Handles both progress display (TTY) and final output (all modes).
 *
 * Uses megarepo's design system components for consistent styling.
 */

import type { Atom } from '@effect-atom/atom'
import React from 'react'
import { useMemo } from 'react'

import { Box, Text, Static, useTuiAtomValue } from '@overeng/tui-react'

import { computeSyncSummary, type MemberSyncResult } from '../../../lib/sync/schema.ts'
import {
  Header,
  TaskItem,
  StatusIcon,
  LogLine as LogLineComponent,
  Separator,
  Summary,
  icons,
  syncToTaskStatus,
} from '../../components/mod.ts'
import type { SyncState, SyncLogEntry } from './schema.ts'

// =============================================================================
// Types
// =============================================================================

/** Props for the SyncView component that renders sync progress and results. */
export interface SyncViewProps {
  stateAtom: Atom.Atom<SyncState>
}

// =============================================================================
// Main View Component
// =============================================================================

/**
 * SyncView - Unified view for sync command.
 *
 * Handles both:
 * - Progress display during sync (phase='syncing')
 * - Final output after sync (phase='complete' or 'idle')
 */
export const SyncView = ({ stateAtom }: SyncViewProps) => {
  const state = useTuiAtomValue(stateAtom)
  const {
    workspace,
    options,
    phase,
    members,
    activeMember,
    results,
    logs,
    nestedMegarepos,
    generatedFiles,
  } = state
  const dryRun = options.dryRun

  // Build mode indicators
  const modes: string[] = []
  if (options.dryRun) modes.push('dry run')
  if (options.frozen) modes.push('frozen')
  if (options.pull) modes.push('pull')
  if (options.force) modes.push('force')
  if (options.all) modes.push('all')

  // Create a map of results by name for quick lookup
  const resultsByName = useMemo(() => {
    const map = new Map<string, MemberSyncResult>()
    for (const r of results) {
      map.set(r.name, r)
    }
    return map
  }, [results])

  // Count errors in results
  const errorCount = useMemo(() => results.filter((r) => r.status === 'error').length, [results])

  // Compute summary counts
  const summaryCounts = useMemo(() => computeSyncSummary(results), [results])

  // ===================
  // Progress View (during sync)
  // ===================
  if (phase === 'syncing') {
    return (
      <>
        {/* Static region: logs */}
        <Static items={logs}>
          {(log: SyncLogEntry) => (
            <LogLineComponent key={log.id} type={log.type} message={log.message} />
          )}
        </Static>

        {/* Dynamic region */}
        <Box paddingTop={logs.length > 0 ? 1 : 0}>
          <Header name={workspace.name} root={workspace.root} modes={modes} />
          <Text> </Text>

          {/* Progress items */}
          {members.map((name) => (
            <ProgressItem
              key={name}
              name={name}
              isActive={name === activeMember}
              result={resultsByName.get(name)}
            />
          ))}

          {/* Progress counter */}
          <Box paddingTop={1}>
            <Text dim>
              {results.length}/{members.length}
              {errorCount > 0 && (
                <Text color="red">
                  {' '}
                  {icons.dot} {errorCount} error{errorCount > 1 ? 's' : ''}
                </Text>
              )}
            </Text>
          </Box>
        </Box>
      </>
    )
  }

  // ===================
  // Interrupted View
  // ===================
  if (phase === 'interrupted') {
    return (
      <Box>
        <Header name={workspace.name} root={workspace.root} modes={modes} />
        <Text> </Text>
        <Text color="yellow" bold>
          {icons.circle} Sync interrupted
        </Text>
        <Text dim>
          Synced {results.length} of {members.length} members before interruption
        </Text>
      </Box>
    )
  }

  // ===================
  // Final View (complete or idle)
  // ===================
  const hasChanges =
    summaryCounts.cloned > 0 ||
    summaryCounts.synced > 0 ||
    summaryCounts.updated > 0 ||
    summaryCounts.locked > 0 ||
    summaryCounts.removed > 0 ||
    summaryCounts.errors > 0

  // Group results by status for ordered display
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
      <Header name={workspace.name} root={workspace.root} modes={modes} />

      {/* Skipped members info */}
      {options.skippedMembers && options.skippedMembers.length > 0 && (
        <Text dim>
          {'  '}skipping {options.skippedMembers.length} member
          {options.skippedMembers.length > 1 ? 's' : ''}: {options.skippedMembers.join(', ')}
        </Text>
      )}

      {/* Empty line after header */}
      <Text> </Text>

      {/* Results */}
      {dryRun && !hasChanges && summaryCounts.errors === 0 ? (
        <Box flexDirection="row">
          <Text color="green">{icons.check}</Text>
          <Text dim> workspace is up to date</Text>
        </Box>
      ) : (
        <>
          {cloned.map((r) => (
            <ClonedLine key={r.name} result={r} />
          ))}
          {synced.map((r) => (
            <SyncedLine key={r.name} result={r} />
          ))}
          {updated.map((r) => (
            <UpdatedLine key={r.name} result={r} />
          ))}
          {locked.map((r) => (
            <LockedLine key={r.name} result={r} />
          ))}
          {removed.map((r) => (
            <RemovedLine key={r.name} result={r} dryRun={dryRun} />
          ))}
          {errors.map((r) => (
            <ErrorLine key={r.name} result={r} />
          ))}
          {skipped.map((r) => (
            <SkippedLine key={r.name} result={r} />
          ))}
          {alreadySynced.length > 0 &&
            (alreadySynced.length <= 5 || hasChanges ? (
              alreadySynced.map((r) => <AlreadySyncedLine key={r.name} result={r} />)
            ) : (
              <Box flexDirection="row">
                <Text dim>
                  {icons.check} {alreadySynced.length} members already synced
                </Text>
              </Box>
            ))}
        </>
      )}

      {/* Separator and summary */}
      <Text> </Text>
      <Separator />
      <Summary
        counts={{
          cloned: summaryCounts.cloned,
          synced: summaryCounts.synced,
          updated: summaryCounts.updated,
          locked: summaryCounts.locked,
          removed: summaryCounts.removed,
          errors: summaryCounts.errors,
          alreadySynced: summaryCounts.alreadySynced,
        }}
        dryRun={dryRun}
      />

      {/* Generated files */}
      {generatedFiles.length > 0 && <GeneratedFiles files={generatedFiles} dryRun={dryRun} />}

      {/* Nested megarepos hint */}
      {nestedMegarepos.length > 0 && !options.all && (
        <NestedMegareposHint count={nestedMegarepos.length} />
      )}
    </Box>
  )
}

// =============================================================================
// Internal Components - Result Line Components (sync-specific formatting)
// =============================================================================

/** Format commit transition (e.g., "abc1234 → def5678") */
const CommitTransition = ({ result }: { result: MemberSyncResult }) => {
  if (result.previousCommit && result.commit) {
    const prev = result.previousCommit.slice(0, 7)
    const curr = result.commit.slice(0, 7)
    return (
      <Text dim>
        {prev} {icons.arrow} {curr}
      </Text>
    )
  }
  if (result.commit) {
    return <Text dim>{result.commit.slice(0, 7)}</Text>
  }
  return null
}

/** Result line for cloned member */
const ClonedLine = ({ result }: { result: MemberSyncResult }) => {
  return (
    <Box flexDirection="row">
      <StatusIcon status="cloned" variant="sync" />
      <Text> </Text>
      <Text bold>{result.name}</Text>
      <Text> </Text>
      <Text color="green">cloned</Text>
      {result.ref && <Text dim> ({result.ref})</Text>}
    </Box>
  )
}

/** Result line for synced member */
const SyncedLine = ({ result }: { result: MemberSyncResult }) => {
  return (
    <Box flexDirection="row">
      <StatusIcon status="synced" variant="sync" />
      <Text> </Text>
      <Text bold>{result.name}</Text>
      <Text> </Text>
      <Text color="green">synced</Text>
      {result.ref && <Text dim> ({result.ref})</Text>}
    </Box>
  )
}

/** Result line for updated member */
const UpdatedLine = ({ result }: { result: MemberSyncResult }) => {
  return (
    <Box flexDirection="row">
      <StatusIcon status="updated" variant="sync" />
      <Text> </Text>
      <Text bold>{result.name}</Text>
      <Text> </Text>
      <Text color="green">updated</Text>
      <Text> </Text>
      <CommitTransition result={result} />
    </Box>
  )
}

/** Result line for locked member */
const LockedLine = ({ result }: { result: MemberSyncResult }) => {
  return (
    <Box flexDirection="row">
      <StatusIcon status="locked" variant="sync" />
      <Text> </Text>
      <Text bold>{result.name}</Text>
      <Text> </Text>
      <Text color="cyan">lock updated</Text>
      <Text> </Text>
      <CommitTransition result={result} />
    </Box>
  )
}

/** Result line for removed member */
const RemovedLine = ({ result, dryRun }: { result: MemberSyncResult; dryRun: boolean }) => {
  return (
    <Box flexDirection="row">
      <StatusIcon status="removed" variant="sync" />
      <Text> </Text>
      <Text bold>{result.name}</Text>
      <Text> </Text>
      <Text color="red">{dryRun ? 'would remove' : 'removed'}</Text>
      {result.message && (
        <Text dim>
          {' '}
          ({icons.arrow} {result.message})
        </Text>
      )}
    </Box>
  )
}

/** Result line for error */
const ErrorLine = ({ result }: { result: MemberSyncResult }) => {
  return (
    <Box flexDirection="row">
      <StatusIcon status="error" variant="sync" />
      <Text> </Text>
      <Text bold>{result.name}</Text>
      <Text> </Text>
      <Text color="red">{result.message ? `error: ${result.message}` : 'error'}</Text>
    </Box>
  )
}

/** Result line for skipped member */
const SkippedLine = ({ result }: { result: MemberSyncResult }) => {
  return (
    <Box flexDirection="row">
      <StatusIcon status="skipped" variant="sync" />
      <Text> </Text>
      <Text bold>{result.name}</Text>
      <Text> </Text>
      <Text color="yellow">{result.message ? `skipped: ${result.message}` : 'skipped'}</Text>
    </Box>
  )
}

/** Result line for already synced member */
const AlreadySyncedLine = ({ result }: { result: MemberSyncResult }) => {
  return (
    <Box flexDirection="row">
      <StatusIcon status="already_synced" variant="sync" />
      <Text> </Text>
      <Text bold>{result.name}</Text>
      <Text> </Text>
      <Text dim>already synced</Text>
    </Box>
  )
}


// =============================================================================
// Internal Components - Generated Files
// =============================================================================

const GeneratedFiles = ({ files, dryRun }: { files: readonly string[]; dryRun: boolean }) => {
  return (
    <Box paddingTop={1}>
      <Text>{dryRun ? 'Would generate:' : 'Generated:'}</Text>
      {files.map((file) => (
        <Box key={file} flexDirection="row">
          <Text> </Text>
          {dryRun ? <Text dim>{icons.arrow}</Text> : <Text color="green">{icons.check}</Text>}
          <Text> </Text>
          <Text bold>{file}</Text>
        </Box>
      ))}
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
        Note: {count} member{count > 1 ? 's' : ''} contain nested megarepos
      </Text>
      <Text dim> Run 'mr sync --all' to sync them</Text>
    </Box>
  )
}

// =============================================================================
// Internal Components - Progress View
// =============================================================================

/** Progress item - shows pending, active (spinner), or completed result */
const ProgressItem = ({
  name,
  isActive,
  result,
}: {
  name: string
  isActive: boolean
  result: MemberSyncResult | undefined
}) => {
  if (result) {
    // Show completed result using TaskItem with mapped status
    const message = getResultMessage(result)
    return (
      <TaskItem
        id={name}
        label={name}
        status={syncToTaskStatus(result.status)}
        {...(message !== undefined && { message })}
      />
    )
  }

  if (isActive) {
    // Show active with spinner
    return <TaskItem id={name} label={name} status="active" message="syncing..." />
  }

  // Show pending
  return <TaskItem id={name} label={name} status="pending" />
}

/** Format commit transition string (e.g., "abc1234 → def5678") */
const formatCommitTransition = (result: MemberSyncResult): string | undefined => {
  if (result.previousCommit && result.commit) {
    const prev = result.previousCommit.slice(0, 7)
    const curr = result.commit.slice(0, 7)
    return `${prev} ${icons.arrow} ${curr}`
  }
  if (result.commit) {
    return result.commit.slice(0, 7)
  }
  return undefined
}

/** Get display message for a sync result */
const getResultMessage = (result: MemberSyncResult): string | undefined => {
  switch (result.status) {
    case 'cloned':
      return result.ref ? `cloned (${result.ref})` : 'cloned'
    case 'synced':
      return result.ref ? `synced (${result.ref})` : 'synced'
    case 'updated': {
      const transition = formatCommitTransition(result)
      return transition ? `updated ${transition}` : 'updated'
    }
    case 'locked': {
      const transition = formatCommitTransition(result)
      return transition ? `lock updated ${transition}` : 'lock updated'
    }
    case 'already_synced':
      return undefined // No message for already synced
    case 'skipped':
      return result.message ? `skipped: ${result.message}` : 'skipped'
    case 'error':
      return result.message ? `error: ${result.message}` : 'error'
    case 'removed':
      return 'removed'
  }
}
