/**
 * SyncOutput View
 *
 * Unified view component for sync command.
 * Handles both progress display (TTY) and final output (all modes).
 *
 * Uses megarepo's design system components for consistent styling.
 */

import type { Atom } from '@effect-atom/atom'
import React, { type ReactNode } from 'react'
import { useMemo } from 'react'

import { Box, Text, Static, Tree, useTuiAtomValue, unicodeSymbols } from '@overeng/tui-react'

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

/** Node in the sync results tree — either a real result or a virtual placeholder */
type SyncTreeNode = {
  result: MemberSyncResult | undefined
  isMegarepo: boolean
  showMegarepoTag: boolean
  children: SyncTreeNode[] | undefined
  collapsedCount?: number | undefined
  nestedErrors?: readonly SyncErrorItem[] | undefined
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
      const segments = nested.root.split('/').filter((s) => s.length > 0)
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
  // Final View data (hooks must be called unconditionally)
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

  // Build tree nodes for Tree component
  const treeNodes: SyncTreeNode[] = useMemo(() => {
    const showAll = options.all === true
    const toNode = (r: MemberSyncResult): SyncTreeNode => {
      const nestedTree = nestedByParent.get(r.name)
      const isMegarepo = nestedMegarepos.includes(r.name)
      const children =
        showAll === true && nestedTree !== undefined && nestedTree.results.length > 0
          ? nestedTree.results.map(toNode)
          : undefined
      return { result: r, isMegarepo, showMegarepoTag: isMegarepo && !showAll, children }
    }

    const ordered = [
      ...cloned,
      ...synced,
      ...updated,
      ...recorded,
      ...applied,
      ...removed,
      ...errors,
      ...skipped,
    ].map(toNode)

    // Collapse many already-synced members into a single placeholder when no changes
    if (alreadySynced.length > 5 && hasChanges === false) {
      ordered.push({
        result: undefined,
        isMegarepo: false,
        showMegarepoTag: false,
        children: undefined,
        collapsedCount: alreadySynced.length,
      })
    } else {
      ordered.push(...alreadySynced.map(toNode))
    }

    // Add nested errors as a virtual node
    if (nestedErrors.length > 0) {
      ordered.push({
        result: undefined,
        isMegarepo: false,
        showMegarepoTag: false,
        children: undefined,
        nestedErrors,
      })
    }

    return ordered
  }, [
    cloned,
    synced,
    updated,
    recorded,
    applied,
    removed,
    errors,
    skipped,
    alreadySynced,
    hasChanges,
    nestedMegarepos,
    nestedByParent,
    nestedErrors,
    options.all,
  ])

  const renderTreeItem = useMemo(
    () => (args: { item: SyncTreeNode; prefix: string }) => {
      const { item, prefix } = args
      // Collapsed already-synced placeholder
      if (item.collapsedCount !== undefined) {
        return (
          <Box flexDirection="row">
            <Text dim>
              {prefix}
              {symbols.check} {item.collapsedCount} members already up to date
            </Text>
          </Box>
        )
      }
      // Nested errors virtual node
      if (item.nestedErrors !== undefined) {
        return (
          <Box flexDirection="column">
            <Box flexDirection="row">
              <Text>{prefix}</Text>
              <Text color="red" bold>
                {symbols.circle} nested errors
              </Text>
            </Box>
            {item.nestedErrors.map((e) => (
              <NestedErrorLine key={`${e.megarepoRoot}:${e.memberName}`} error={e} />
            ))}
          </Box>
        )
      }
      // Normal result node
      if (item.result === undefined) return null
      return (
        <SyncResultLine
          result={item.result}
          lockSync={lockSyncByMember.get(item.result.name)}
          mode={options.mode}
          dryRun={dryRun}
          verbose={verbose}
          prefix={prefix}
          showMegarepoTag={item.showMegarepoTag}
        />
      )
    },
    [options.mode, dryRun, verbose, lockSyncByMember],
  )

  const renderTreeChildContent = useMemo(
    () => (args: { item: SyncTreeNode; continuationPrefix: string }) => {
      const { item, continuationPrefix } = args
      if (item.result === undefined) return null
      const r = item.result
      // Align child content with the member name: continuationPrefix aligns with
      // the tree branch chars, add icon(1) + space(1) to match where the name starts.
      const contentPrefix = `${continuationPrefix}  `
      return (
        <>
          {/* Ref mismatch: multi-line details (description + hint) */}
          {r.status === 'skipped' && r.refMismatch !== undefined && (
            <RefMismatchDetails result={r} prefix={contentPrefix} />
          )}
          {/* Verbose lock details */}
          {verbose === true && (
            <InlineLockDetails
              memberName={r.name}
              lockSyncByMember={lockSyncByMember}
              prefix={contentPrefix}
            />
          )}
        </>
      )
    },
    [verbose, lockSyncByMember],
  )

  const getTreeChildren = useMemo(() => (item: SyncTreeNode) => item.children, [])

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

      {/* Results as a tree rooted at workspace */}
      {dryRun === true && hasChanges === false && summaryCounts.errors === 0 ? (
        <Box flexDirection="row">
          <Text>{tree.last}</Text>
          <Text color="green">{symbols.check}</Text>
          <Text dim> workspace is up to date</Text>
        </Box>
      ) : (
        <Tree<SyncTreeNode>
          items={treeNodes}
          getChildren={getTreeChildren}
          renderItem={renderTreeItem}
          renderChildContent={renderTreeChildContent}
        />
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

/** Width of the file type column (longest type "megarepo.lock" = 13, + 2 padding) */
const FILE_TYPE_COL_WIDTH = 15

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
  const paddedFileLabel = (fileType ?? '').padEnd(FILE_TYPE_COL_WIDTH)

  switch (update._tag) {
    case 'RevUpdate':
      return (
        <Box flexDirection="row">
          <Text dim>
            {prefix}
            {paddedFileLabel}
            {update.inputName} rev {update.oldRev} {symbols.arrow} {update.newRev}
          </Text>
        </Box>
      )
    case 'RefUpdate':
      return (
        <Box flexDirection="row">
          <Text>
            {prefix}
            {paddedFileLabel}
          </Text>
          <Text color="cyan">
            {update.inputName} ref {update.oldRef} {symbols.arrow} {update.newRef}
          </Text>
        </Box>
      )
  }
}

// =============================================================================
// Internal Components - Result Line
// =============================================================================

type ResultDisplay = {
  verb: string
  color: 'green' | 'cyan' | 'red' | 'yellow' | 'dim'
  detail?: ReactNode
}

/** Compute the status verb, color, and inline detail fragments for a sync result */
const getResultDisplay = ({
  result,
  mode,
  dryRun,
}: {
  result: MemberSyncResult
  mode: SyncMode
  dryRun: boolean
}): ResultDisplay => {
  switch (result.status) {
    case 'cloned':
      return {
        verb: 'cloned',
        color: 'green',
        detail: result.ref !== undefined ? <Text dim> ({result.ref})</Text> : undefined,
      }
    case 'synced':
      return {
        verb: 'synced',
        color: 'green',
        detail: result.ref !== undefined ? <Text dim> ({result.ref})</Text> : undefined,
      }
    case 'updated':
      return {
        verb: mode === 'fetch' ? 'fetched' : 'updated',
        color: 'green',
        detail: <CommitTransition result={result} />,
      }
    case 'recorded':
      return {
        verb: dryRun === true ? 'would record' : 'recorded',
        color: 'cyan',
        detail: <RecordedDetail result={result} />,
      }
    case 'applied':
      return {
        verb: dryRun === true ? 'would check out' : 'checked out',
        color: 'cyan',
        detail:
          result.commit !== undefined ? <Text dim> {result.commit.slice(0, 7)}</Text> : undefined,
      }
    case 'removed':
      return {
        verb: dryRun === true ? 'would remove' : 'removed',
        color: 'red',
        detail:
          result.message !== undefined ? (
            <Text dim>
              {' '}
              ({symbols.arrow} {result.message})
            </Text>
          ) : undefined,
      }
    case 'error':
      return {
        verb: result.message !== undefined ? `error: ${result.message}` : 'error',
        color: 'red',
      }
    case 'skipped': {
      if (result.refMismatch !== undefined) return { verb: 'ref mismatch', color: 'yellow' }
      return {
        verb: result.message !== undefined ? `skipped: ${result.message}` : 'skipped',
        color: 'yellow',
      }
    }
    case 'already_synced':
      return {
        verb: 'already up to date',
        color: 'dim',
      }
  }
}

/** Unified result line — renders prefix + icon + name + verb + detail + badges */
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
  const { verb, color, detail } = getResultDisplay({ result, mode, dryRun })
  const showLockBadge = verbose !== true && result.status !== 'error' && result.status !== 'skipped'
  return (
    <Box flexDirection="row">
      {prefix !== undefined && <Text>{prefix}</Text>}
      <StatusIcon status={result.status} variant="sync" />
      <Text> </Text>
      <Text bold>{result.name}</Text>
      <Text> </Text>
      {color === 'dim' ? <Text dim>{verb}</Text> : <Text color={color}>{verb}</Text>}
      {detail}
      {showLockBadge === true && <LockSyncBadge lockSync={lockSync} />}
      {showMegarepoTag === true && <MegarepoTag />}
    </Box>
  )
}

/** Commit transition inline detail (e.g., "abc1234 → def5678") */
const CommitTransition = ({ result }: { result: MemberSyncResult }) => {
  if (result.previousCommit !== undefined && result.commit !== undefined) {
    return (
      <Text dim>
        {' '}
        {result.previousCommit.slice(0, 7)} {symbols.arrow} {result.commit.slice(0, 7)}
      </Text>
    )
  }
  if (result.commit !== undefined) {
    return <Text dim> {result.commit.slice(0, 7)}</Text>
  }
  return null
}

/** Recorded status inline detail — commit transition or new entry */
const RecordedDetail = ({ result }: { result: MemberSyncResult }) => {
  if (result.previousCommit !== undefined) return <CommitTransition result={result} />
  if (result.commit !== undefined) {
    return <Text dim> {result.commit.slice(0, 7)} (new entry)</Text>
  }
  return null
}

/** Detail lines for skipped ref mismatch — rendered below the member line with tree continuation */
const RefMismatchDetails = ({ result, prefix }: { result: MemberSyncResult; prefix: string }) => {
  const { expectedRef, actualRef, isDetached } = result.refMismatch!
  const mismatchDesc =
    isDetached === true
      ? `store path implies '${expectedRef}' but worktree is detached at ${actualRef}`
      : `store path implies '${expectedRef}' but worktree HEAD is '${actualRef}'`

  return (
    <>
      <Box flexDirection="row">
        <Text dim>
          {prefix}
          {mismatchDesc}
        </Text>
      </Box>
      <Box flexDirection="row">
        <Text dim>
          {prefix}hint: use 'mr config pin {result.name} -c {actualRef}' to{' '}
          {isDetached === true ? 'pin this commit' : 'create proper worktree'},
        </Text>
      </Box>
      <Box flexDirection="row">
        <Text dim>
          {prefix}
          {'      '}or 'git checkout {expectedRef}' to restore expected state
        </Text>
      </Box>
    </>
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
