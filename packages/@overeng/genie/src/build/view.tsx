/**
 * Genie View
 *
 * Unified view component for genie command.
 * Handles both progress display (TTY) and final output (all modes).
 */

import React, { useMemo } from 'react'

import { Box, Text, Spinner, useViewport, useTuiAtomValue } from '@overeng/tui-react'

import { GenieApp } from './app.ts'
import type { GenieState, GenieFile, GenieFileStatus } from './schema.ts'

// =============================================================================
// Icons (matching megarepo design system)
// =============================================================================

const icons = {
  check: '\u2713', // ✓
  cross: '\u2717', // ✗
  circle: '\u25cb', // ○
  dot: '\u00b7', // ·
  separator: '\u2500', // ─
} as const

// =============================================================================
// File List Utilities
// =============================================================================

/** Priority order for file statuses (lower = higher priority) */
const statusPriority: Record<GenieFileStatus, number> = {
  error: 0,
  active: 1,
  created: 2,
  updated: 3,
  skipped: 4,
  pending: 5,
  unchanged: 6,
}

/** Sort files by priority: errors > active > changed > pending > unchanged */
const sortFilesByPriority = (files: readonly GenieFile[]): GenieFile[] => {
  return [...files].sort((a, b) => statusPriority[a.status] - statusPriority[b.status])
}

/** Calculate overflow summary from hidden files */
const getOverflowSummary = (hiddenFiles: readonly GenieFile[]): string => {
  const counts: Partial<Record<GenieFileStatus, number>> = {}
  for (const file of hiddenFiles) {
    counts[file.status] = (counts[file.status] ?? 0) + 1
  }

  const parts: string[] = []
  if (counts.unchanged) parts.push(`${counts.unchanged} ${icons.check}`)
  if (counts.pending) parts.push(`${counts.pending} pending`)
  if (counts.created) parts.push(`${counts.created} created`)
  if (counts.updated) parts.push(`${counts.updated} updated`)
  if (counts.skipped) parts.push(`${counts.skipped} skipped`)
  // errors and active should never be hidden, but just in case
  if (counts.error) parts.push(`${counts.error} errors`)
  if (counts.active) parts.push(`${counts.active} active`)

  return `... ${hiddenFiles.length} more files (${parts.join(', ')})`
}

// =============================================================================
// Status Icon Component
// =============================================================================

const StatusIcon = ({ status }: { status: GenieFileStatus }) => {
  switch (status) {
    case 'pending':
      return <Text dim>{icons.circle}</Text>
    case 'active':
      return <Spinner type="dots" />
    case 'created':
    case 'updated':
      return <Text color="green">{icons.check}</Text>
    case 'unchanged':
      return <Text dim>{icons.check}</Text>
    case 'skipped':
      return <Text color="yellow">{icons.circle}</Text>
    case 'error':
      return <Text color="red">{icons.cross}</Text>
  }
}

// =============================================================================
// File Item Component
// =============================================================================

const FileItem = ({ file }: { file: GenieFile }) => {
  const isActive = file.status === 'active'
  const hasDiffStats = file.linesAdded !== undefined || file.linesRemoved !== undefined

  // Determine if this file should be highlighted (changed) or dimmed
  const isHighlighted =
    file.status === 'created' ||
    file.status === 'updated' ||
    file.status === 'error' ||
    file.status === 'skipped' ||
    file.status === 'active'

  // Format status label (created, updated, etc.)
  const statusLabel = useMemo(() => {
    switch (file.status) {
      case 'active':
        return 'generating...'
      case 'created':
        return 'created'
      case 'updated':
        return 'updated'
      case 'unchanged':
        return undefined
      case 'skipped':
        return file.message ? `skipped: ${file.message}` : 'skipped'
      case 'error':
        return file.message ? `error: ${file.message}` : 'error'
      default:
        return undefined
    }
  }, [file.status, file.message])

  return (
    <Box flexDirection="row">
      <StatusIcon status={file.status} />
      <Text> </Text>
      <Text color={isHighlighted ? 'white' : undefined} dim={!isHighlighted}>
        {file.relativePath}
      </Text>
      {/* Diff stats: +N in green, -M in red */}
      {hasDiffStats && (
        <>
          <Text> </Text>
          {file.linesAdded !== undefined && file.linesAdded > 0 && (
            <Text color="green">+{file.linesAdded}</Text>
          )}
          {file.linesAdded !== undefined &&
            file.linesRemoved !== undefined &&
            file.linesAdded > 0 &&
            file.linesRemoved > 0 && <Text dim>/</Text>}
          {file.linesRemoved !== undefined && file.linesRemoved > 0 && (
            <Text color="red">-{file.linesRemoved}</Text>
          )}
        </>
      )}
      {/* Status label */}
      {statusLabel && (
        <>
          <Text> </Text>
          <Text dim={!isActive} color={file.status === 'error' ? 'red' : undefined}>
            {statusLabel}
          </Text>
        </>
      )}
    </Box>
  )
}

// =============================================================================
// Header Component
// =============================================================================

interface HeaderProps {
  mode: string
  phase: GenieState['phase']
  files: readonly GenieFile[]
  cwd: string
}

const Header = ({ mode, phase, files, cwd }: HeaderProps) => {
  // Calculate progress counts
  const completed = files.filter((f) => f.status !== 'pending' && f.status !== 'active').length
  const total = files.length
  const errors = files.filter((f) => f.status === 'error').length

  // Mode badge
  const modeBadge = mode === 'dry-run' ? '[DRY RUN]' : mode === 'check' ? '[CHECK]' : null

  // Phase display
  const renderPhase = () => {
    switch (phase) {
      case 'discovering':
        return (
          <>
            <Spinner type="dots" />
            <Text> Discovering...</Text>
          </>
        )
      case 'generating':
        return (
          <>
            <Spinner type="dots" />
            <Text> Generating </Text>
            <Text bold>
              {completed}/{total}
            </Text>
            {errors > 0 && (
              <Text color="red">
                {' '}
                {icons.dot} {errors} error{errors > 1 ? 's' : ''}
              </Text>
            )}
          </>
        )
      case 'complete':
        return (
          <>
            <Text color="green">{icons.check}</Text>
            <Text> Complete</Text>
          </>
        )
      case 'error':
        return (
          <>
            <Text color="red">{icons.cross}</Text>
            <Text color="red"> Error</Text>
          </>
        )
    }
  }

  return (
    <Box flexDirection="row">
      <Text bold>Genie</Text>
      {modeBadge && (
        <>
          <Text> </Text>
          <Text color="yellow">{modeBadge}</Text>
        </>
      )}
      <Text dim> › </Text>
      {renderPhase()}
      <Text dim>
        {' '}
        {icons.dot} {cwd}
      </Text>
    </Box>
  )
}

// =============================================================================
// Separator Component
// =============================================================================

const Separator = () => <Text dim>{icons.separator.repeat(40)}</Text>

// =============================================================================
// Summary Component
// =============================================================================

const Summary = ({
  summary,
  mode,
}: {
  summary: NonNullable<GenieState['summary']>
  mode: string
}) => {
  const parts: string[] = []

  if (summary.created > 0) {
    parts.push(`${summary.created} created`)
  }
  if (summary.updated > 0) {
    parts.push(`${summary.updated} updated`)
  }
  if (summary.unchanged > 0) {
    parts.push(`${summary.unchanged} unchanged`)
  }
  if (summary.skipped > 0) {
    parts.push(`${summary.skipped} skipped`)
  }
  if (summary.failed > 0) {
    parts.push(`${summary.failed} failed`)
  }

  const total =
    summary.created + summary.updated + summary.unchanged + summary.skipped + summary.failed
  const prefix = mode === 'check' ? 'Checked' : mode === 'dry-run' ? 'Would process' : 'Processed'

  return (
    <Box flexDirection="row">
      <Text>{prefix} </Text>
      <Text bold>{total}</Text>
      <Text> files: </Text>
      <Text>{parts.join(', ')}</Text>
    </Box>
  )
}

// =============================================================================
// Viewport-Aware File List
// =============================================================================

interface FileListProps {
  files: readonly GenieFile[]
  hasWatchCycle: boolean
}

/**
 * Viewport-aware file list that prioritizes important files.
 * Shows errors and active files first, then fills remaining space with others.
 * Displays overflow summary when files exceed available viewport height.
 */
const FileList = ({ files, hasWatchCycle }: FileListProps) => {
  const viewport = useViewport()

  const { visibleFiles, hiddenFiles } = useMemo(() => {
    // Calculate available lines for file list
    // Layout: Header (1) + watch cycle? (1) + blank (1) + files + overflow? (1)
    const reservedLines = 1 + (hasWatchCycle ? 1 : 0) + 1 + 1 // +1 for overflow line
    const availableLines = Math.max(1, viewport.rows - reservedLines)

    // If all files fit, no need to sort/truncate
    if (files.length <= availableLines) {
      return { visibleFiles: files, hiddenFiles: [] as GenieFile[] }
    }

    // Sort by priority and split into visible/hidden
    const sorted = sortFilesByPriority(files)
    return {
      visibleFiles: sorted.slice(0, availableLines - 1), // -1 for overflow indicator
      hiddenFiles: sorted.slice(availableLines - 1),
    }
  }, [files, viewport.rows, hasWatchCycle])

  return (
    <>
      {visibleFiles.map((file) => (
        <FileItem key={file.path} file={file} />
      ))}
      {hiddenFiles.length > 0 && <Text dim>{getOverflowSummary(hiddenFiles)}</Text>}
    </>
  )
}

// =============================================================================
// Main View Component
// =============================================================================

/** Props for GenieView component */
export interface GenieViewProps {
  state: GenieState
}

/**
 * GenieView - Unified view for genie command.
 *
 * Handles:
 * - Progress display during generation (phase='generating')
 * - Final output after completion (phase='complete')
 * - Error display (phase='error')
 */
export const GenieView = ({ state }: GenieViewProps) => {
  const { phase, mode, cwd, files, summary, error, watchCycle } = state

  // ===================
  // Discovering Phase
  // ===================
  if (phase === 'discovering') {
    return (
      <Box>
        <Header mode={mode} phase={phase} files={files} cwd={cwd} />
      </Box>
    )
  }

  // ===================
  // Error Phase
  // ===================
  if (phase === 'error') {
    return (
      <Box>
        <Header mode={mode} phase={phase} files={files} cwd={cwd} />
        <Text> </Text>
        <Text color="red">{error ?? 'An error occurred'}</Text>
      </Box>
    )
  }

  // ===================
  // Generating Phase (Progress)
  // ===================
  if (phase === 'generating') {
    return (
      <Box>
        <Header mode={mode} phase={phase} files={files} cwd={cwd} />
        {watchCycle !== undefined && watchCycle > 0 && (
          <Text dim>Watch cycle #{watchCycle + 1}</Text>
        )}
        <Text> </Text>

        {/* File progress items - viewport aware */}
        <FileList files={files} hasWatchCycle={watchCycle !== undefined && watchCycle > 0} />
      </Box>
    )
  }

  // ===================
  // Complete Phase
  // ===================
  // Check for changes/errors
  const hasChanges = files.some(
    (f) => f.status === 'created' || f.status === 'updated' || f.status === 'error',
  )

  return (
    <Box>
      <Header mode={mode} phase={phase} files={files} cwd={cwd} />
      {watchCycle !== undefined && watchCycle > 0 && <Text dim>Watch cycle #{watchCycle + 1}</Text>}
      <Text> </Text>

      {/* Results - viewport aware with priority sorting */}
      {!hasChanges ? (
        <Box flexDirection="row">
          <Text color="green">{icons.check}</Text>
          <Text> </Text>
          <Text dim>All files up to date</Text>
        </Box>
      ) : (
        <FileList files={files} hasWatchCycle={watchCycle !== undefined && watchCycle > 0} />
      )}

      {/* Separator and summary */}
      {summary && (
        <>
          <Text> </Text>
          <Separator />
          <Summary summary={summary} mode={mode} />
        </>
      )}
    </Box>
  )
}

// =============================================================================
// Connected View (uses app-scoped hooks)
// =============================================================================

/**
 * Connected view that uses GenieApp's hooks.
 * Use this when rendering with GenieApp.run().
 */
export const GenieConnectedView = () => {
  const state = useTuiAtomValue(GenieApp.stateAtom)
  return <GenieView state={state} />
}
