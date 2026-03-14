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

import {
  computeSyncSummary,
  type MemberSyncResult,
  type SyncErrorItem,
  type SyncMode,
} from '../../../lib/sync/schema.ts'
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
import type {
  SyncState,
  SyncLogEntry,
  MemberLockSyncResult,
  LockFileUpdate,
  LockSharedSourceUpdate,
  PreflightIssue,
} from './schema.ts'

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
 * - Progress display during sync (_tag='Syncing')
 * - Final output after sync (_tag='Success' or _tag='Error')
 */
export const SyncView = ({ stateAtom }: SyncViewProps) => {
  const state = useTuiAtomValue(stateAtom)
  const {
    _tag,
    workspace,
    options,
    members,
    activeMembers,
    results,
    logs,
    nestedMegarepos,
    generatedFiles,
    lockSyncResults,
    sharedSourceUpdates,
    syncErrors,
    syncErrorCount,
  } = state
  const dryRun = options.dryRun
  const verbose = options.verbose ?? false

  // Build mode indicators
  const modes: string[] = []
  switch (options.mode) {
    case 'apply':
      modes.push('apply')
      break
    case 'lock':
      modes.push('lock')
      break
    case 'fetch':
      modes.push('fetch')
      break
  }
  if (options.dryRun === true) modes.push('dry run')
  if (options.force === true) modes.push('force')
  if (options.all === true) modes.push('all')

  // Create a map of results by name for quick lookup
  const resultsByName = useMemo(() => {
    const map = new Map<string, MemberSyncResult>()
    for (const r of results) {
      map.set(r.name, r)
    }
    return map
  }, [results])

  // Count errors in the full sync tree (root + nested)
  const errorCount = syncErrorCount

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
    total += (sharedSourceUpdates ?? []).length
    return total
  }, [lockSyncResults, sharedSourceUpdates])

  // ===================
  // Progress View (during sync)
  // ===================
  if (_tag === 'Syncing') {
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
              isActive={activeMembers.includes(name)}
              result={resultsByName.get(name)}
              mode={options.mode}
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
  if (_tag === 'Interrupted') {
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
  // Pre-flight Failed View
  // ===================
  if (_tag === 'PreflightFailed') {
    return (
      <Box>
        <Header name={workspace.name} root={workspace.root} modes={modes} />
        <Text> </Text>
        <PreflightFailedView issues={state.preflightIssues} mode={options.mode} />
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
    summaryCounts.recorded > 0 ||
    summaryCounts.applied > 0 ||
    summaryCounts.removed > 0 ||
    summaryCounts.errors > 0

  // Group results by status for ordered display
  const cloned = results.filter((r) => r.status === 'cloned')
  const synced = results.filter((r) => r.status === 'synced')
  const updated = results.filter((r) => r.status === 'updated')
  const recorded = results.filter((r) => r.status === 'recorded')
  const applied = results.filter((r) => r.status === 'applied')
  const removed = results.filter((r) => r.status === 'removed')
  const errors = results.filter((r) => r.status === 'error')
  const nestedErrors = syncErrors.filter((e) => e.megarepoRoot !== workspace.root)
  const skipped = results.filter((r) => r.status === 'skipped')
  const alreadySynced = results.filter((r) => r.status === 'already_synced')

  return (
    <Box>
      {/* Header */}
      <Header name={workspace.name} root={workspace.root} modes={modes} />

      {/* Skipped members info */}
      {options.skippedMembers !== undefined && options.skippedMembers.length > 0 && (
        <Text dim>
          {'  '}skipping {options.skippedMembers.length} member
          {options.skippedMembers.length > 1 ? 's' : ''}: {options.skippedMembers.join(', ')}
        </Text>
      )}

      {/* Empty line after header */}
      <Text> </Text>

      {/* Results */}
      {dryRun === true && hasChanges === false && summaryCounts.errors === 0 ? (
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
            <UpdatedLine key={r.name} result={r} lockSync={lockSyncByMember.get(r.name)} mode={options.mode} />
          ))}
          {recorded.map((r) => (
            <RecordedLine
              key={r.name}
              result={r}
              lockSync={lockSyncByMember.get(r.name)}
              dryRun={dryRun}
            />
          ))}
          {applied.map((r) => (
            <AppliedLine key={r.name} result={r} dryRun={dryRun} />
          ))}
          {removed.map((r) => (
            <RemovedLine key={r.name} result={r} dryRun={dryRun} />
          ))}
          {errors.map((r) => (
            <ErrorLine key={r.name} result={r} />
          ))}
          {nestedErrors.length > 0 && (
            <Box flexDirection="column">
              <Text color="red" bold>
                {symbols.circle} nested errors
              </Text>
              {nestedErrors.map((e) => (
                <NestedErrorLine key={`${e.megarepoRoot}:${e.memberName}`} error={e} />
              ))}
            </Box>
          )}
          {skipped.map((r) => (
            <SkippedLine key={r.name} result={r} />
          ))}
          {alreadySynced.length > 0 &&
            (alreadySynced.length <= 5 || hasChanges === true ? (
              alreadySynced.map((r) => (
                <AlreadySyncedLine
                  key={r.name}
                  result={r}
                  lockSync={lockSyncByMember.get(r.name)}
                  mode={options.mode}
                />
              ))
            ) : (
              <Box flexDirection="row">
                <Text dim>
                  {symbols.check} {alreadySynced.length} members {options.mode === 'fetch' ? 'already up to date' : 'already synced'}
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
          recorded: summaryCounts.recorded,
          applied: summaryCounts.applied,
          removed: summaryCounts.removed,
          errors: errorCount,
          alreadySynced: summaryCounts.alreadySynced,
        }}
        dryRun={dryRun}
        mode={options.mode}
      />

      {/* Generated files */}
      {generatedFiles.length > 0 && <GeneratedFiles files={generatedFiles} dryRun={dryRun} />}

      {/* Lock sync summary */}
      {totalLockSyncUpdates > 0 && (
        <LockSyncSection
          results={lockSyncResults ?? []}
          sharedSourceUpdates={sharedSourceUpdates ?? []}
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
// Internal Components - Pre-flight Failed View
// =============================================================================

const PreflightFailedView = ({
  issues,
  mode,
}: {
  issues: readonly PreflightIssue[]
  mode: string
}) => {
  const errors = issues.filter((i) => i.severity === 'error')
  const warnings = issues.filter((i) => i.severity === 'warning')

  return (
    <Box flexDirection="column">
      <Text color="red" bold>
        {symbols.cross} Store hygiene check failed
      </Text>
      <Text> </Text>
      {errors.map((issue, i) => (
        <Box key={`err-${issue.memberName}-${issue.type}-${i}`} flexDirection="column">
          <Box flexDirection="row">
            <Text color="red">{symbols.cross}</Text>
            <Text> </Text>
            <Text bold>{issue.memberName}</Text>
            <Text dim> ({issue.type})</Text>
          </Box>
          <Box paddingLeft={4}>
            <Text dim>{issue.message}</Text>
          </Box>
          {issue.fix !== undefined && (
            <Box paddingLeft={4}>
              <Text dim>fix: {issue.fix}</Text>
            </Box>
          )}
        </Box>
      ))}
      {warnings.map((issue, i) => (
        <Box key={`warn-${issue.memberName}-${issue.type}-${i}`} flexDirection="column">
          <Box flexDirection="row">
            <Text color="yellow">{symbols.circle}</Text>
            <Text> </Text>
            <Text bold>{issue.memberName}</Text>
            <Text dim> ({issue.type})</Text>
          </Box>
          <Box paddingLeft={4}>
            <Text dim>{issue.message}</Text>
          </Box>
        </Box>
      ))}
      <Text> </Text>
      <Separator />
      <Text dim>
        Run 'mr store fix' to resolve issues, or pass '--no-strict' to skip pre-flight checks
      </Text>
    </Box>
  )
}

const NestedErrorLine = ({ error }: { error: SyncErrorItem }) => {
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box flexDirection="row">
        <StatusIcon status="error" variant="sync" />
        <Text> </Text>
        <Text bold>{error.memberName}</Text>
        <Text> </Text>
        <Text dim>({error.megarepoRoot})</Text>
      </Box>
      {error.message !== undefined && (
        <Box paddingLeft={4}>
          <Text dim>{error.message}</Text>
        </Box>
      )}
    </Box>
  )
}

// =============================================================================
// Internal Components - Lock Sync Badge (Option 3: inline indicator)
// =============================================================================

/** Count total lock input updates for a member */
const countLockInputUpdates = (lockSync: MemberLockSyncResult | undefined): number => {
  if (lockSync === undefined) return 0
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
  if (result.previousCommit !== undefined && result.commit !== undefined) {
    const prev = result.previousCommit.slice(0, 7)
    const curr = result.commit.slice(0, 7)
    return (
      <Text dim>
        {prev} {symbols.arrow} {curr}
      </Text>
    )
  }
  if (result.commit !== undefined) {
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

/** Result line for updated member (shows "fetched" in fetch mode, "updated" otherwise) */
const UpdatedLine = ({
  result,
  lockSync,
  mode,
}: {
  result: MemberSyncResult
  lockSync: MemberLockSyncResult | undefined
  mode: SyncMode
}) => {
  const verb = mode === 'fetch' ? 'fetched' : 'updated'
  return (
    <Box flexDirection="row">
      <StatusIcon status="updated" variant="sync" />
      <Text> </Text>
      <Text bold>{result.name}</Text>
      <Text> </Text>
      <Text color="green">{verb}</Text>
      <Text> </Text>
      <CommitTransition result={result} />
      <LockSyncBadge lockSync={lockSync} />
    </Box>
  )
}

/** Result line for recorded member (lock sync — wrote commit to lockfile) */
const RecordedLine = ({
  result,
  lockSync,
  dryRun,
}: {
  result: MemberSyncResult
  lockSync: MemberLockSyncResult | undefined
  dryRun: boolean
}) => {
  const verb = dryRun === true ? 'would record' : 'recorded'
  const hasTransition = result.previousCommit !== undefined
  return (
    <Box flexDirection="row">
      <StatusIcon status="recorded" variant="sync" />
      <Text> </Text>
      <Text bold>{result.name}</Text>
      <Text> </Text>
      <Text color="cyan">{verb}</Text>
      <Text> </Text>
      {hasTransition === true ? (
        <CommitTransition result={result} />
      ) : result.commit !== undefined ? (
        <>
          <Text dim>{result.commit.slice(0, 7)}</Text>
          <Text dim> (new entry)</Text>
        </>
      ) : null}
      <LockSyncBadge lockSync={lockSync} />
    </Box>
  )
}

/** Result line for applied member (lock apply — checked out commit from lockfile) */
const AppliedLine = ({ result, dryRun }: { result: MemberSyncResult; dryRun: boolean }) => {
  const verb = dryRun === true ? 'would check out' : 'checked out'
  return (
    <Box flexDirection="row">
      <StatusIcon status="applied" variant="sync" />
      <Text> </Text>
      <Text bold>{result.name}</Text>
      <Text> </Text>
      <Text color="cyan">{verb}</Text>
      {result.commit !== undefined && <Text dim> {result.commit.slice(0, 7)}</Text>}
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
      <Text color="red">{dryRun === true ? 'would remove' : 'removed'}</Text>
      {result.message !== undefined && (
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
  if (result.message !== undefined) {
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
  if (result.refMismatch !== undefined) {
    const { expectedRef, actualRef, isDetached } = result.refMismatch
    const mismatchDesc =
      isDetached === true
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
            {isDetached === true ? 'pin this commit' : 'create proper worktree'},
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
  if (result.message !== undefined) {
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

/** Result line for already synced member (shows "already up to date" in fetch mode) */
const AlreadySyncedLine = ({
  result,
  lockSync,
  mode,
}: {
  result: MemberSyncResult
  lockSync: MemberLockSyncResult | undefined
  mode: SyncMode
}) => {
  const label = mode === 'fetch' ? 'already up to date' : 'already synced'
  return (
    <Box flexDirection="row">
      <StatusIcon status="already_synced" variant="sync" />
      <Text> </Text>
      <Text bold>{result.name}</Text>
      <Text> </Text>
      <Text dim>{label}</Text>
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
      <Text>{dryRun === true ? 'Would generate:' : 'Generated:'}</Text>
      {files.map((file) => (
        <Box key={file} flexDirection="row">
          <Text> </Text>
          {dryRun === true ? (
            <Text dim>{symbols.arrow}</Text>
          ) : (
            <Text color="green">{symbols.check}</Text>
          )}
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

/** Render a single lock file update line */
const LockFileUpdateLine = ({ update }: { update: LockFileUpdate }) => {
  switch (update._tag) {
    case 'RevUpdate':
      return (
        <Box paddingLeft={2} flexDirection="row">
          <Text dim>
            {update.inputName}: {update.oldRev} {symbols.arrow} {update.newRev}
          </Text>
        </Box>
      )
    case 'RefUpdate':
      return (
        <Box paddingLeft={2} flexDirection="row">
          <Text color="cyan">
            {update.inputName}: {update.oldRef} {symbols.arrow} {update.newRef}
          </Text>
        </Box>
      )
  }
}

/** Lock sync summary section with verbose expansion */
const LockSyncSection = ({
  results,
  sharedSourceUpdates,
  totalUpdates,
  verbose,
  dryRun,
}: {
  results: readonly MemberLockSyncResult[]
  sharedSourceUpdates: readonly LockSharedSourceUpdate[]
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
          {dryRun === true ? 'Would update' : 'Updated'} {totalUpdates} lock input
          {totalUpdates > 1 ? 's' : ''} across {memberCount} member{memberCount > 1 ? 's' : ''}
        </Text>
      </Box>

      {/* Verbose details */}
      {verbose &&
        results.map((memberResult) => {
          const hasUpdates = memberResult.files.some((f) => f.updatedInputs.length > 0)
          if (hasUpdates === false) return null

          return (
            <Box key={memberResult.memberName} paddingLeft={2} flexDirection="column">
              <Text dim>{memberResult.memberName}/</Text>
              {memberResult.files.map((file) => {
                if (file.updatedInputs.length === 0) return null
                return (
                  <Box key={file.type} paddingLeft={2} flexDirection="column">
                    <Text dim>{file.type}:</Text>
                    {file.updatedInputs.map((input, idx) => (
                      <LockFileUpdateLine key={`${input._tag}-${idx}`} update={input} />
                    ))}
                  </Box>
                )
              })}
            </Box>
          )
        })}

      {/* Shared source updates */}
      {verbose && sharedSourceUpdates.length > 0 && (
        <Box paddingLeft={2} flexDirection="column">
          <Text dim>shared lock sources:</Text>
          {sharedSourceUpdates.map((update) => (
            <Box key={update.sourceName} paddingLeft={2} flexDirection="row">
              <Text dim>
                {update.sourceName}: propagated from {update.sourceMemberName} to{' '}
                {update.targetCount} member{update.targetCount > 1 ? 's' : ''}
              </Text>
            </Box>
          ))}
        </Box>
      )}
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
      <Text dim> Run 'mr apply --all' to sync them</Text>
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
  mode,
}: {
  name: string
  isActive: boolean
  result: MemberSyncResult | undefined
  mode: SyncMode
}) => {
  if (result !== undefined) {
    // Show completed result using TaskItem with mapped status
    const message = getResultMessage(result, mode)
    return (
      <TaskItem
        id={name}
        label={name}
        status={syncToTaskStatus(result.status)}
        {...(message !== undefined && { message })}
      />
    )
  }

  if (isActive === true) {
    // Show active with spinner
    return <TaskItem id={name} label={name} status="active" message="syncing..." />
  }

  // Show pending
  return <TaskItem id={name} label={name} status="pending" />
}

/** Format commit transition string (e.g., "abc1234 → def5678") */
const formatCommitTransition = (result: MemberSyncResult): string | undefined => {
  if (result.previousCommit !== undefined && result.commit !== undefined) {
    const prev = result.previousCommit.slice(0, 7)
    const curr = result.commit.slice(0, 7)
    return `${prev} ${symbols.arrow} ${curr}`
  }
  if (result.commit !== undefined) {
    return result.commit.slice(0, 7)
  }
  return undefined
}

/** Get display message for a sync result */
const getResultMessage = (result: MemberSyncResult, mode: SyncMode): string | undefined => {
  switch (result.status) {
    case 'cloned':
      return result.ref !== undefined ? `cloned (${result.ref})` : 'cloned'
    case 'synced':
      return result.ref !== undefined ? `synced (${result.ref})` : 'synced'
    case 'updated': {
      const verb = mode === 'fetch' ? 'fetched' : 'updated'
      const transition = formatCommitTransition(result)
      return transition !== undefined ? `${verb} ${transition}` : verb
    }
    case 'recorded': {
      const transition = formatCommitTransition(result)
      return transition !== undefined ? `recorded ${transition}` : 'recorded'
    }
    case 'applied':
      return result.commit !== undefined
        ? `checked out ${result.commit.slice(0, 7)}`
        : 'checked out'
    case 'already_synced':
      return undefined // No message for already synced
    case 'skipped':
      // For ref mismatch, show a concise message (full details shown in final view)
      if (result.refMismatch !== undefined) {
        return `ref mismatch (expected ${result.refMismatch.expectedRef})`
      }
      return result.message !== undefined ? `skipped: ${result.message}` : 'skipped'
    case 'error':
      return result.message !== undefined ? `error: ${result.message}` : 'error'
    case 'removed':
      return 'removed'
  }
}
