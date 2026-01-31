/**
 * Genie View
 *
 * Unified view component for genie command.
 * Handles both progress display (TTY) and final output (all modes).
 */

import React, { useMemo } from 'react'

import { Box, Text, Spinner } from '@overeng/tui-react'

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
    case 'unchanged':
      return <Text color="green">{icons.check}</Text>
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
  const isPending = file.status === 'pending'
  const isActive = file.status === 'active'

  // Format status message
  const statusMessage = useMemo(() => {
    switch (file.status) {
      case 'active':
        return 'generating...'
      case 'created':
        return 'created'
      case 'updated':
        return file.message ? `updated ${file.message}` : 'updated'
      case 'unchanged':
        return undefined // No message for unchanged
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
      <Text bold={!isPending} dim={isPending}>
        {file.relativePath}
      </Text>
      {statusMessage && (
        <>
          <Text> </Text>
          <Text dim={!isActive} color={file.status === 'error' ? 'red' : undefined}>
            {statusMessage}
          </Text>
        </>
      )}
    </Box>
  )
}

// =============================================================================
// Header Component
// =============================================================================

const Header = ({ cwd, mode }: { cwd: string; mode: string }) => {
  const modeLabel = mode === 'dry-run' ? '(dry run)' : mode === 'check' ? '(check)' : ''

  return (
    <Box flexDirection="row">
      <Text bold>Genie</Text>
      {modeLabel && (
        <>
          <Text> </Text>
          <Text dim>{modeLabel}</Text>
        </>
      )}
      <Text> </Text>
      <Text dim>{cwd}</Text>
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
// Progress Counter
// =============================================================================

const ProgressCounter = ({ files }: { files: readonly GenieFile[] }) => {
  const completed = files.filter((f) => f.status !== 'pending' && f.status !== 'active').length
  const total = files.length
  const errors = files.filter((f) => f.status === 'error').length

  return (
    <Box flexDirection="row" paddingTop={1}>
      <Text dim>
        {completed}/{total}
      </Text>
      {errors > 0 && (
        <>
          <Text> </Text>
          <Text color="red">
            {icons.dot} {errors} error{errors > 1 ? 's' : ''}
          </Text>
        </>
      )}
    </Box>
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
        <Header cwd={cwd} mode={mode} />
        <Text> </Text>
        <Box flexDirection="row">
          <Spinner type="dots" />
          <Text> </Text>
          <Text>Discovering .genie.ts files...</Text>
        </Box>
      </Box>
    )
  }

  // ===================
  // Error Phase
  // ===================
  if (phase === 'error') {
    return (
      <Box>
        <Header cwd={cwd} mode={mode} />
        <Text> </Text>
        <Box flexDirection="row">
          <Text color="red">{icons.cross}</Text>
          <Text> </Text>
          <Text color="red">{error ?? 'An error occurred'}</Text>
        </Box>
      </Box>
    )
  }

  // ===================
  // Generating Phase (Progress)
  // ===================
  if (phase === 'generating') {
    return (
      <Box>
        <Header cwd={cwd} mode={mode} />
        {watchCycle !== undefined && watchCycle > 0 && (
          <Text dim>Watch cycle #{watchCycle + 1}</Text>
        )}
        <Text> </Text>

        {/* File progress items */}
        {files.map((file) => (
          <FileItem key={file.path} file={file} />
        ))}

        {/* Progress counter */}
        <ProgressCounter files={files} />
      </Box>
    )
  }

  // ===================
  // Complete Phase
  // ===================
  // Group files by status for ordered display
  const created = files.filter((f) => f.status === 'created')
  const updated = files.filter((f) => f.status === 'updated')
  const unchanged = files.filter((f) => f.status === 'unchanged')
  const skipped = files.filter((f) => f.status === 'skipped')
  const errors = files.filter((f) => f.status === 'error')

  const hasChanges = created.length > 0 || updated.length > 0 || errors.length > 0

  return (
    <Box>
      <Header cwd={cwd} mode={mode} />
      {watchCycle !== undefined && watchCycle > 0 && <Text dim>Watch cycle #{watchCycle + 1}</Text>}
      <Text> </Text>

      {/* Results */}
      {!hasChanges && errors.length === 0 ? (
        <Box flexDirection="row">
          <Text color="green">{icons.check}</Text>
          <Text> </Text>
          <Text dim>All files up to date</Text>
        </Box>
      ) : (
        <>
          {created.map((f) => (
            <FileItem key={f.path} file={f} />
          ))}
          {updated.map((f) => (
            <FileItem key={f.path} file={f} />
          ))}
          {errors.map((f) => (
            <FileItem key={f.path} file={f} />
          ))}
          {skipped.map((f) => (
            <FileItem key={f.path} file={f} />
          ))}
          {/* Show unchanged only if there are other changes, otherwise summarize */}
          {unchanged.length > 0 && hasChanges && unchanged.length <= 5 ? (
            unchanged.map((f) => <FileItem key={f.path} file={f} />)
          ) : unchanged.length > 0 && hasChanges ? (
            <Box flexDirection="row">
              <Text dim>
                {icons.check} {unchanged.length} files unchanged
              </Text>
            </Box>
          ) : null}
        </>
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
  const state = GenieApp.useState()
  return <GenieView state={state} />
}
