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
  symbols,
  syncToTaskStatus,
} from '../../components/mod.ts'
import type { SyncState, SyncLogEntry, MemberLockSyncResult } from './schema.ts'

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
    lockSyncResults,
  } = state
  const dryRun = options.dryRun
  const verbose = options.verbose ?? false

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

  // Create a map of lock sync results by member name for quick lookup
  const lockSyncByMember = useMemo(() => {
    const map = new Map<string, MemberLockSyncResult>()
    for (const r of lockSyncResults ?? []) {
      map.set(r.memberName, r)
    }
    return map
  }, [lockSyncResults])

  // Count total lock sync updates
  const totalLockSyncUpdates = useMemo(() => {
    let total = 0
    for (const r of lockSyncResults ?? []) {
      for (const f of r.files) {
        total += f.updatedInputs.length
      }
    }
    return total
  }, [lockSyncResults])

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
                  {symbols.dot} {errorCount} error{errorCount > 1 ? 's' : ''}
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
          {symbols.circle} Sync interrupted
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
          <Text color="green">{symbols.check}</Text>
          <Text dim> workspace is up to date</Text>
        </Box>
      ) : (
        <>
          {cloned.map((r) => (
            <ClonedLine key={r.name} result={r} lockSync={lockSyncByMember.get(r.name)} />
          ))}
          {synced.map((r) => (
            <SyncedLine key={r.name} result={r} lockSync={lockSyncByMember.get(r.name)} />
          ))}
          {updated.map((r) => (
            <UpdatedLine key={r.name} result={r} lockSync={lockSyncByMember.get(r.name)} />
          ))}
          {locked.map((r) => (
            <LockedLine key={r.name} result={r} lockSync={lockSyncByMember.get(r.name)} />
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
              alreadySynced.map((r) => (
                <AlreadySyncedLine
                  key={r.name}
                  result={r}
                  lockSync={lockSyncByMember.get(r.name)}
                />
              ))
            ) : (
              <Box flexDirection="row">
                <Text dim>
                  {symbols.check} {alreadySynced.length} members already synced
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

      {/* Lock sync summary */}
      {totalLockSyncUpdates > 0 && (
        <LockSyncSection
          results={lockSyncResults ?? []}
          totalUpdates={totalLockSyncUpdates}
          verbose={verbose}
          dryRun={dryRun}
        />
      )}

      {/* Nested megarepos hint */}
      {nestedMegarepos.length > 0 && !options.all && (
        <NestedMegareposHint count={nestedMegarepos.length} />
      )}
    </Box>
  )
}

// =============================================================================
// Internal Components - Lock Sync Badge (Option 3: inline indicator)
// =============================================================================

/** Count total lock input updates for a member */
const countLockInputUpdates = (lockSync: MemberLockSyncResult | undefined): number => {
  if (!lockSync) return 0
  let count = 0
  for (const f of lockSync.files) {
    count += f.updatedInputs.length
  }
  return count
}

/** Inline badge showing lock sync updates (Option 3) */
const LockSyncBadge = ({ lockSync }: { lockSync: MemberLockSyncResult | undefined }) => {
  const count = countLockInputUpdates(lockSync)
  if (count === 0) return null
  return (
    <Text dim>
      {' '}
      {symbols.dot} {count} lock input{count > 1 ? 's' : ''} updated
    </Text>
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
        {prev} {symbols.arrow} {curr}
      </Text>
    )
  }
  if (result.commit) {
    return <Text dim>{result.commit.slice(0, 7)}</Text>
  }
  return null
}

/** Result line for cloned member */
const ClonedLine = ({
  result,
  lockSync,
}: {
  result: MemberSyncResult
  lockSync: MemberLockSyncResult | undefined
}) => {
  return (
    <Box flexDirection="row">
      <StatusIcon status="cloned" variant="sync" />
      <Text> </Text>
      <Text bold>{result.name}</Text>
      <Text> </Text>
      <Text color="green">cloned</Text>
      {result.ref && <Text dim> ({result.ref})</Text>}
      <LockSyncBadge lockSync={lockSync} />
    </Box>
  )
}

/** Result line for synced member */
const SyncedLine = ({
  result,
  lockSync,
}: {
  result: MemberSyncResult
  lockSync: MemberLockSyncResult | undefined
}) => {
  return (
    <Box flexDirection="row">
      <StatusIcon status="synced" variant="sync" />
      <Text> </Text>
      <Text bold>{result.name}</Text>
      <Text> </Text>
      <Text color="green">synced</Text>
      {result.ref && <Text dim> ({result.ref})</Text>}
      <LockSyncBadge lockSync={lockSync} />
    </Box>
  )
}

/** Result line for updated member */
const UpdatedLine = ({
  result,
  lockSync,
}: {
  result: MemberSyncResult
  lockSync: MemberLockSyncResult | undefined
}) => {
  return (
    <Box flexDirection="row">
      <StatusIcon status="updated" variant="sync" />
      <Text> </Text>
      <Text bold>{result.name}</Text>
      <Text> </Text>
      <Text color="green">updated</Text>
      <Text> </Text>
      <CommitTransition result={result} />
      <LockSyncBadge lockSync={lockSync} />
    </Box>
  )
}

/** Result line for locked member */
const LockedLine = ({
  result,
  lockSync,
}: {
  result: MemberSyncResult
  lockSync: MemberLockSyncResult | undefined
}) => {
  return (
    <Box flexDirection="row">
      <StatusIcon status="locked" variant="sync" />
      <Text> </Text>
      <Text bold>{result.name}</Text>
      <Text> </Text>
      <Text color="cyan">lock updated</Text>
      <Text> </Text>
      <CommitTransition result={result} />
      <LockSyncBadge lockSync={lockSync} />
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
          ({symbols.arrow} {result.message})
        </Text>
      )}
    </Box>
  )
}

/** Result line for error - uses multi-line format to show full error message */
const ErrorLine = ({ result }: { result: MemberSyncResult }) => {
  // Multi-line format for errors with messages (similar to SkippedLine with refMismatch)
  if (result.message) {
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <StatusIcon status="error" variant="sync" />
          <Text> </Text>
          <Text bold>{result.name}</Text>
          <Text> </Text>
          <Text color="red">error:</Text>
        </Box>
        <Box paddingLeft={4}>
          <Text dim>{result.message}</Text>
        </Box>
      </Box>
    )
  }

  // Single line for errors without message
  return (
    <Box flexDirection="row">
      <StatusIcon status="error" variant="sync" />
      <Text> </Text>
      <Text bold>{result.name}</Text>
      <Text> </Text>
      <Text color="red">error</Text>
    </Box>
  )
}

/** Result line for skipped member */
const SkippedLine = ({ result }: { result: MemberSyncResult }) => {
  // Handle ref mismatch with structured display (multiline hints)
  if (result.refMismatch) {
    const { expectedRef, actualRef, isDetached } = result.refMismatch
    const mismatchDesc = isDetached
      ? `store path implies '${expectedRef}' but worktree is detached at ${actualRef}`
      : `store path implies '${expectedRef}' but worktree HEAD is '${actualRef}'`

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <StatusIcon status="skipped" variant="sync" />
          <Text> </Text>
          <Text bold>{result.name}</Text>
          <Text> </Text>
          <Text color="yellow">ref mismatch</Text>
        </Box>
        <Box paddingLeft={4}>
          <Text dim>{mismatchDesc}</Text>
        </Box>
        <Box paddingLeft={4}>
          <Text dim>
            hint: use 'mr pin {result.name} -c {actualRef}' to{' '}
            {isDetached ? 'pin this commit' : 'create proper worktree'},
          </Text>
        </Box>
        <Box paddingLeft={4}>
          <Text dim>
            {'      '}or 'git checkout {expectedRef}' to restore expected state
          </Text>
        </Box>
      </Box>
    )
  }

  // Standard skipped line (non-ref-mismatch) - multi-line format for long messages
  if (result.message) {
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <StatusIcon status="skipped" variant="sync" />
          <Text> </Text>
          <Text bold>{result.name}</Text>
          <Text> </Text>
          <Text color="yellow">skipped:</Text>
        </Box>
        <Box paddingLeft={4}>
          <Text dim>{result.message}</Text>
        </Box>
      </Box>
    )
  }

  // No message - single line
  return (
    <Box flexDirection="row">
      <StatusIcon status="skipped" variant="sync" />
      <Text> </Text>
      <Text bold>{result.name}</Text>
      <Text> </Text>
      <Text color="yellow">skipped</Text>
    </Box>
  )
}

/** Result line for already synced member */
const AlreadySyncedLine = ({
  result,
  lockSync,
}: {
  result: MemberSyncResult
  lockSync: MemberLockSyncResult | undefined
}) => {
  return (
    <Box flexDirection="row">
      <StatusIcon status="already_synced" variant="sync" />
      <Text> </Text>
      <Text bold>{result.name}</Text>
      <Text> </Text>
      <Text dim>already synced</Text>
      <LockSyncBadge lockSync={lockSync} />
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
          {dryRun ? <Text dim>{symbols.arrow}</Text> : <Text color="green">{symbols.check}</Text>}
          <Text> </Text>
          <Text bold>{file}</Text>
        </Box>
      ))}
    </Box>
  )
}

// =============================================================================
// Internal Components - Lock Sync Section (Option 2: expandable section)
// =============================================================================

/** Lock sync summary section with verbose expansion */
const LockSyncSection = ({
  results,
  totalUpdates,
  verbose,
  dryRun,
}: {
  results: readonly MemberLockSyncResult[]
  totalUpdates: number
  verbose: boolean
  dryRun: boolean
}) => {
  const memberCount = results.filter((r) => r.files.some((f) => f.updatedInputs.length > 0)).length

  return (
    <Box paddingTop={1}>
      {/* Summary line */}
      <Box flexDirection="row">
        <Text color="cyan">{symbols.check}</Text>
        <Text> </Text>
        <Text>
          {dryRun ? 'Would update' : 'Updated'} {totalUpdates} lock input
          {totalUpdates > 1 ? 's' : ''} across {memberCount} member{memberCount > 1 ? 's' : ''}
        </Text>
      </Box>

      {/* Verbose details */}
      {verbose &&
        results.map((memberResult) => {
          const hasUpdates = memberResult.files.some((f) => f.updatedInputs.length > 0)
          if (!hasUpdates) return null

          return (
            <Box key={memberResult.memberName} paddingLeft={2} flexDirection="column">
              <Text dim>{memberResult.memberName}/</Text>
              {memberResult.files.map((file) => {
                if (file.updatedInputs.length === 0) return null
                return (
                  <Box key={file.type} paddingLeft={2} flexDirection="column">
                    <Text dim>{file.type}:</Text>
                    {file.updatedInputs.map((input) => (
                      <Box key={input.inputName} paddingLeft={2} flexDirection="row">
                        <Text dim>
                          {input.inputName}: {input.oldRev} {symbols.arrow} {input.newRev}
                        </Text>
                      </Box>
                    ))}
                  </Box>
                )
              })}
            </Box>
          )
        })}
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
    return `${prev} ${symbols.arrow} ${curr}`
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
      // For ref mismatch, show a concise message (full details shown in final view)
      if (result.refMismatch) {
        return `ref mismatch (expected ${result.refMismatch.expectedRef})`
      }
      return result.message ? `skipped: ${result.message}` : 'skipped'
    case 'error':
      return result.message ? `error: ${result.message}` : 'error'
    case 'removed':
      return 'removed'
  }
}
