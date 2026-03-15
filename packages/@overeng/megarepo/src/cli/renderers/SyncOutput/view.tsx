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

import { Box, Text, Static, useTuiAtomValue, unicodeSymbols } from '@overeng/tui-react'

import {
  computeSyncSummary,
  type MegarepoSyncTree,
  type MemberSyncResult,
  type SyncErrorItem,
  type SyncMode,
} from '../../../lib/sync/schema.ts'
import {
  WorkspaceRootLabel,
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
    syncTree,
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
  if (verbose === true) modes.push('verbose')

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

  // Build nested-by-parent map from syncTree
  const nestedByParent = useMemo(() => {
    const map = new Map<string, MegarepoSyncTree>()
    for (const nested of syncTree.nestedResults) {
      const segments = nested.root.split('/')
      const parentName = segments[segments.length - 1]
      if (parentName !== undefined) {
        map.set(parentName, nested)
      }
    }
    return map
  }, [syncTree.nestedResults])

  // Combine root + nested results for accurate summary counts
  const allResults = useMemo(() => {
    const combined = [...results]
    for (const nested of syncTree.nestedResults) {
      combined.push(...nested.results)
    }
    return combined
  }, [results, syncTree.nestedResults])

  // Compute summary counts from all results (root + nested)
  const summaryCounts = useMemo(() => computeSyncSummary(allResults), [allResults])

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
          <WorkspaceRootLabel storePath={workspace.root} modes={modes} />
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
        <WorkspaceRootLabel storePath={workspace.root} modes={modes} />
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
        <WorkspaceRootLabel storePath={workspace.root} modes={modes} />
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
      <WorkspaceRootLabel storePath={workspace.root} modes={modes} />

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
            <RootResultWithNested
              key={r.name}
              result={r}
              lockSync={lockSyncByMember.get(r.name)}
              mode={options.mode}
              dryRun={dryRun}
              verbose={verbose}
              showAll={options.all === true}
              isMegarepo={nestedMegarepos.includes(r.name)}
              nestedTree={nestedByParent.get(r.name)}
              lockSyncByMember={lockSyncByMember}
            />
          ))}
          {synced.map((r) => (
            <RootResultWithNested
              key={r.name}
              result={r}
              lockSync={lockSyncByMember.get(r.name)}
              mode={options.mode}
              dryRun={dryRun}
              verbose={verbose}
              showAll={options.all === true}
              isMegarepo={nestedMegarepos.includes(r.name)}
              nestedTree={nestedByParent.get(r.name)}
              lockSyncByMember={lockSyncByMember}
            />
          ))}
          {updated.map((r) => (
            <RootResultWithNested
              key={r.name}
              result={r}
              lockSync={lockSyncByMember.get(r.name)}
              mode={options.mode}
              dryRun={dryRun}
              verbose={verbose}
              showAll={options.all === true}
              isMegarepo={nestedMegarepos.includes(r.name)}
              nestedTree={nestedByParent.get(r.name)}
              lockSyncByMember={lockSyncByMember}
            />
          ))}
          {recorded.map((r) => (
            <RootResultWithNested
              key={r.name}
              result={r}
              lockSync={lockSyncByMember.get(r.name)}
              mode={options.mode}
              dryRun={dryRun}
              verbose={verbose}
              showAll={options.all === true}
              isMegarepo={nestedMegarepos.includes(r.name)}
              nestedTree={nestedByParent.get(r.name)}
              lockSyncByMember={lockSyncByMember}
            />
          ))}
          {applied.map((r) => (
            <RootResultWithNested
              key={r.name}
              result={r}
              lockSync={lockSyncByMember.get(r.name)}
              mode={options.mode}
              dryRun={dryRun}
              verbose={verbose}
              showAll={options.all === true}
              isMegarepo={nestedMegarepos.includes(r.name)}
              nestedTree={nestedByParent.get(r.name)}
              lockSyncByMember={lockSyncByMember}
            />
          ))}
          {removed.map((r) => (
            <RootResultWithNested
              key={r.name}
              result={r}
              lockSync={lockSyncByMember.get(r.name)}
              mode={options.mode}
              dryRun={dryRun}
              verbose={verbose}
              showAll={options.all === true}
              isMegarepo={nestedMegarepos.includes(r.name)}
              nestedTree={nestedByParent.get(r.name)}
              lockSyncByMember={lockSyncByMember}
            />
          ))}
          {errors.map((r) => (
            <RootResultWithNested
              key={r.name}
              result={r}
              lockSync={lockSyncByMember.get(r.name)}
              mode={options.mode}
              dryRun={dryRun}
              verbose={verbose}
              showAll={options.all === true}
              isMegarepo={nestedMegarepos.includes(r.name)}
              nestedTree={nestedByParent.get(r.name)}
              lockSyncByMember={lockSyncByMember}
            />
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
            <SyncResultLine
              key={r.name}
              result={r}
              lockSync={lockSyncByMember.get(r.name)}
              mode={options.mode}
              dryRun={dryRun}
              verbose={verbose}
            />
          ))}
          {alreadySynced.length > 0 &&
            (alreadySynced.length <= 5 || hasChanges === true ? (
              alreadySynced.map((r) => (
                <RootResultWithNested
                  key={r.name}
                  result={r}
                  lockSync={lockSyncByMember.get(r.name)}
                  mode={options.mode}
                  dryRun={dryRun}
                  verbose={verbose}
                  showAll={options.all === true}
                  isMegarepo={nestedMegarepos.includes(r.name)}
                  nestedTree={nestedByParent.get(r.name)}
                  lockSyncByMember={lockSyncByMember}
                />
              ))
            ) : (
              <Box flexDirection="row">
                <Text dim>
                  {symbols.check} {alreadySynced.length} members{' '}
                  {options.mode === 'fetch' ? 'already up to date' : 'already synced'}
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
          sharedSourceUpdates={sharedSourceUpdates ?? []}
          totalUpdates={totalLockSyncUpdates}
          dryRun={dryRun}
        />
      )}

      {/* Nested megarepos hint */}
      {nestedMegarepos.length > 0 && options.all !== true && (
        <NestedMegareposHint count={nestedMegarepos.length} />
      )}
    </Box>
  )
}

// =============================================================================
// Tree Symbols
// =============================================================================

const tree = {
  middle: unicodeSymbols.tree.branch,
  last: unicodeSymbols.tree.last,
  vertical: unicodeSymbols.tree.vertical,
  empty: unicodeSymbols.tree.empty,
}

// =============================================================================
// Internal Components - Pre-flight Failed View
// =============================================================================

const PreflightFailedView = ({
  issues,
  mode: _mode,
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
      <Text dim>Run 'mr store fix' to resolve issues</Text>
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
// Internal Components - Lock Sync Badge (inline indicator)
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

/** Inline badge showing lock sync updates */
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

/** [megarepo] badge shown when --all is off */
const MegarepoTag = () => <Text color="cyan"> [megarepo]</Text>

// =============================================================================
// Internal Components - Inline Lock Details (verbose mode)
// =============================================================================

/** Renders lock file updates inline below a member line */
const InlineLockDetails = ({
  memberName,
  lockSyncByMember,
  prefix,
}: {
  memberName: string
  lockSyncByMember: ReadonlyMap<string, MemberLockSyncResult>
  prefix: string
}) => {
  const lockSync = lockSyncByMember.get(memberName)
  if (lockSync === undefined) return null

  const filesWithUpdates = lockSync.files.filter((f) => f.updatedInputs.length > 0)
  if (filesWithUpdates.length === 0) return null

  return (
    <>
      {filesWithUpdates.map((file) => (
        <Box key={file.type} flexDirection="column">
          {file.updatedInputs.map((input, idx) => (
            <LockUpdateLine
              key={`${input._tag}-${idx}`}
              update={input}
              fileType={idx === 0 ? file.type : undefined}
              prefix={prefix}
            />
          ))}
        </Box>
      ))}
    </>
  )
}

/** Render a single lock file update line with optional file type label */
const LockUpdateLine = ({
  update,
  fileType,
  prefix,
}: {
  update: LockFileUpdate
  fileType: string | undefined
  prefix: string
}) => {
  const paddedFileLabel = fileType !== undefined ? `${fileType}  ` : '           '

  switch (update._tag) {
    case 'RevUpdate':
      return (
        <Box flexDirection="row">
          <Text dim>
            {prefix} {paddedFileLabel}
            {update.inputName} rev {update.oldRev} {symbols.arrow} {update.newRev}
          </Text>
        </Box>
      )
    case 'RefUpdate':
      return (
        <Box flexDirection="row">
          <Text>
            {prefix} {paddedFileLabel}
          </Text>
          <Text color="cyan">
            {update.inputName} ref {update.oldRef} {symbols.arrow} {update.newRef}
          </Text>
        </Box>
      )
  }
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

/** Dispatcher component routing to the correct line component based on result.status */
const SyncResultLine = ({
  result,
  lockSync,
  mode,
  dryRun,
  verbose,
  prefix,
  showMegarepoTag,
}: {
  result: MemberSyncResult
  lockSync: MemberLockSyncResult | undefined
  mode: SyncMode
  dryRun: boolean
  verbose: boolean
  prefix?: string | undefined
  showMegarepoTag?: boolean | undefined
}) => {
  switch (result.status) {
    case 'cloned':
      return (
        <ClonedLine
          result={result}
          lockSync={lockSync}
          prefix={prefix}
          verbose={verbose}
          showMegarepoTag={showMegarepoTag}
        />
      )
    case 'synced':
      return (
        <SyncedLine
          result={result}
          lockSync={lockSync}
          prefix={prefix}
          verbose={verbose}
          showMegarepoTag={showMegarepoTag}
        />
      )
    case 'updated':
      return (
        <UpdatedLine
          result={result}
          lockSync={lockSync}
          mode={mode}
          prefix={prefix}
          verbose={verbose}
          showMegarepoTag={showMegarepoTag}
        />
      )
    case 'recorded':
      return (
        <RecordedLine
          result={result}
          lockSync={lockSync}
          dryRun={dryRun}
          prefix={prefix}
          verbose={verbose}
          showMegarepoTag={showMegarepoTag}
        />
      )
    case 'applied':
      return <AppliedLine result={result} dryRun={dryRun} prefix={prefix} />
    case 'removed':
      return <RemovedLine result={result} dryRun={dryRun} prefix={prefix} />
    case 'error':
      return <ErrorLine result={result} prefix={prefix} />
    case 'skipped':
      return <SkippedLine result={result} prefix={prefix} />
    case 'already_synced':
      return (
        <AlreadySyncedLine
          result={result}
          lockSync={lockSync}
          mode={mode}
          prefix={prefix}
          verbose={verbose}
          showMegarepoTag={showMegarepoTag}
        />
      )
  }
}

/** Wrapper that renders a root result line + inline lock details (verbose) + nested tree children */
const RootResultWithNested = ({
  result,
  lockSync,
  mode,
  dryRun,
  verbose,
  showAll,
  isMegarepo,
  nestedTree,
  lockSyncByMember,
}: {
  result: MemberSyncResult
  lockSync: MemberLockSyncResult | undefined
  mode: SyncMode
  dryRun: boolean
  verbose: boolean
  showAll: boolean
  isMegarepo: boolean
  nestedTree: MegarepoSyncTree | undefined
  lockSyncByMember: ReadonlyMap<string, MemberLockSyncResult>
}) => {
  const showTag = isMegarepo === true && showAll === false
  const hasNestedChildren =
    showAll === true && nestedTree !== undefined && nestedTree.results.length > 0

  return (
    <>
      <SyncResultLine
        result={result}
        lockSync={lockSync}
        mode={mode}
        dryRun={dryRun}
        verbose={verbose}
        showMegarepoTag={showTag}
      />
      {verbose === true && (
        <InlineLockDetails memberName={result.name} lockSyncByMember={lockSyncByMember} prefix="" />
      )}
      {hasNestedChildren === true && nestedTree !== undefined && (
        <>
          {nestedTree.results.map((child, i) => {
            const isLast = i === nestedTree.results.length - 1
            const branchChar = isLast === true ? tree.last : tree.middle
            const continuationPrefix = isLast === true ? tree.empty : tree.vertical

            return (
              <React.Fragment key={child.name}>
                <SyncResultLine
                  result={child}
                  lockSync={lockSyncByMember.get(child.name)}
                  mode={mode}
                  dryRun={dryRun}
                  verbose={verbose}
                  prefix={branchChar}
                />
                {verbose === true && (
                  <InlineLockDetails
                    memberName={child.name}
                    lockSyncByMember={lockSyncByMember}
                    prefix={continuationPrefix}
                  />
                )}
              </React.Fragment>
            )
          })}
        </>
      )}
    </>
  )
}

/** Result line for cloned member */
const ClonedLine = ({
  result,
  lockSync,
  prefix,
  verbose,
  showMegarepoTag,
}: {
  result: MemberSyncResult
  lockSync: MemberLockSyncResult | undefined
  prefix?: string | undefined
  verbose?: boolean | undefined
  showMegarepoTag?: boolean | undefined
}) => {
  return (
    <Box flexDirection="row">
      {prefix !== undefined && <Text>{prefix}</Text>}
      <StatusIcon status="cloned" variant="sync" />
      <Text> </Text>
      <Text bold>{result.name}</Text>
      <Text> </Text>
      <Text color="green">cloned</Text>
      {result.ref && <Text dim> ({result.ref})</Text>}
      {verbose !== true && <LockSyncBadge lockSync={lockSync} />}
      {showMegarepoTag === true && <MegarepoTag />}
    </Box>
  )
}

/** Result line for synced member */
const SyncedLine = ({
  result,
  lockSync,
  prefix,
  verbose,
  showMegarepoTag,
}: {
  result: MemberSyncResult
  lockSync: MemberLockSyncResult | undefined
  prefix?: string | undefined
  verbose?: boolean | undefined
  showMegarepoTag?: boolean | undefined
}) => {
  return (
    <Box flexDirection="row">
      {prefix !== undefined && <Text>{prefix}</Text>}
      <StatusIcon status="synced" variant="sync" />
      <Text> </Text>
      <Text bold>{result.name}</Text>
      <Text> </Text>
      <Text color="green">synced</Text>
      {result.ref && <Text dim> ({result.ref})</Text>}
      {verbose !== true && <LockSyncBadge lockSync={lockSync} />}
      {showMegarepoTag === true && <MegarepoTag />}
    </Box>
  )
}

/** Result line for updated member (shows "fetched" in fetch mode, "updated" otherwise) */
const UpdatedLine = ({
  result,
  lockSync,
  mode,
  prefix,
  verbose,
  showMegarepoTag,
}: {
  result: MemberSyncResult
  lockSync: MemberLockSyncResult | undefined
  mode: SyncMode
  prefix?: string | undefined
  verbose?: boolean | undefined
  showMegarepoTag?: boolean | undefined
}) => {
  const verb = mode === 'fetch' ? 'fetched' : 'updated'
  return (
    <Box flexDirection="row">
      {prefix !== undefined && <Text>{prefix}</Text>}
      <StatusIcon status="updated" variant="sync" />
      <Text> </Text>
      <Text bold>{result.name}</Text>
      <Text> </Text>
      <Text color="green">{verb}</Text>
      <Text> </Text>
      <CommitTransition result={result} />
      {verbose !== true && <LockSyncBadge lockSync={lockSync} />}
      {showMegarepoTag === true && <MegarepoTag />}
    </Box>
  )
}

/** Result line for recorded member (lock sync — wrote commit to lockfile) */
const RecordedLine = ({
  result,
  lockSync,
  dryRun,
  prefix,
  verbose,
  showMegarepoTag,
}: {
  result: MemberSyncResult
  lockSync: MemberLockSyncResult | undefined
  dryRun: boolean
  prefix?: string | undefined
  verbose?: boolean | undefined
  showMegarepoTag?: boolean | undefined
}) => {
  const verb = dryRun === true ? 'would record' : 'recorded'
  const hasTransition = result.previousCommit !== undefined
  return (
    <Box flexDirection="row">
      {prefix !== undefined && <Text>{prefix}</Text>}
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
      {verbose !== true && <LockSyncBadge lockSync={lockSync} />}
      {showMegarepoTag === true && <MegarepoTag />}
    </Box>
  )
}

/** Result line for applied member (lock apply — checked out commit from lockfile) */
const AppliedLine = ({
  result,
  dryRun,
  prefix,
}: {
  result: MemberSyncResult
  dryRun: boolean
  prefix?: string | undefined
}) => {
  const verb = dryRun === true ? 'would check out' : 'checked out'
  return (
    <Box flexDirection="row">
      {prefix !== undefined && <Text>{prefix}</Text>}
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
const RemovedLine = ({
  result,
  dryRun,
  prefix,
}: {
  result: MemberSyncResult
  dryRun: boolean
  prefix?: string | undefined
}) => {
  return (
    <Box flexDirection="row">
      {prefix !== undefined && <Text>{prefix}</Text>}
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
const ErrorLine = ({
  result,
  prefix,
}: {
  result: MemberSyncResult
  prefix?: string | undefined
}) => {
  if (result.message !== undefined) {
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          {prefix !== undefined && <Text>{prefix}</Text>}
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

  return (
    <Box flexDirection="row">
      {prefix !== undefined && <Text>{prefix}</Text>}
      <StatusIcon status="error" variant="sync" />
      <Text> </Text>
      <Text bold>{result.name}</Text>
      <Text> </Text>
      <Text color="red">error</Text>
    </Box>
  )
}

/** Result line for skipped member */
const SkippedLine = ({
  result,
  prefix,
}: {
  result: MemberSyncResult
  prefix?: string | undefined
}) => {
  if (result.refMismatch !== undefined) {
    const { expectedRef, actualRef, isDetached } = result.refMismatch
    const mismatchDesc =
      isDetached === true
        ? `store path implies '${expectedRef}' but worktree is detached at ${actualRef}`
        : `store path implies '${expectedRef}' but worktree HEAD is '${actualRef}'`

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          {prefix !== undefined && <Text>{prefix}</Text>}
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
            hint: use 'mr config pin {result.name} -c {actualRef}' to{' '}
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

  if (result.message !== undefined) {
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          {prefix !== undefined && <Text>{prefix}</Text>}
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

  return (
    <Box flexDirection="row">
      {prefix !== undefined && <Text>{prefix}</Text>}
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
  prefix,
  verbose,
  showMegarepoTag,
}: {
  result: MemberSyncResult
  lockSync: MemberLockSyncResult | undefined
  mode: SyncMode
  prefix?: string | undefined
  verbose?: boolean | undefined
  showMegarepoTag?: boolean | undefined
}) => {
  const label = mode === 'fetch' ? 'already up to date' : 'already synced'
  return (
    <Box flexDirection="row">
      {prefix !== undefined && <Text>{prefix}</Text>}
      <StatusIcon status="already_synced" variant="sync" />
      <Text> </Text>
      <Text bold>{result.name}</Text>
      <Text> </Text>
      <Text dim>{label}</Text>
      {verbose !== true && <LockSyncBadge lockSync={lockSync} />}
      {showMegarepoTag === true && <MegarepoTag />}
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
// Internal Components - Lock Sync Section (simplified summary)
// =============================================================================

/** Simplified lock sync summary — just total count + shared source updates */
const LockSyncSection = ({
  sharedSourceUpdates,
  totalUpdates,
  dryRun,
}: {
  sharedSourceUpdates: readonly LockSharedSourceUpdate[]
  totalUpdates: number
  dryRun: boolean
}) => {
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color="cyan">{symbols.check}</Text>
        <Text>
          {' '}
          {totalUpdates} lock input{totalUpdates > 1 ? 's' : ''}{' '}
          {dryRun === true ? 'would be updated' : 'updated'}
        </Text>
      </Box>

      {sharedSourceUpdates.length > 0 &&
        sharedSourceUpdates.map((update) => (
          <Text key={update.sourceName} dim>
            {'  '}
            {update.sourceName} version propagated from {update.sourceMemberName} {symbols.arrow}{' '}
            {update.targetCount} member{update.targetCount > 1 ? 's' : ''}
          </Text>
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
        Note: {count} member{count > 1 ? 's' : ''} contain{count === 1 ? 's' : ''} nested megarepos{' '}
        {symbols.arrow} use --all to include
      </Text>
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
    const message = getResultMessage({ result, mode })
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
    return <TaskItem id={name} label={name} status="active" message="syncing..." />
  }

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
const getResultMessage = ({
  result,
  mode,
}: {
  result: MemberSyncResult
  mode: SyncMode
}): string | undefined => {
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
      return undefined
    case 'skipped':
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
