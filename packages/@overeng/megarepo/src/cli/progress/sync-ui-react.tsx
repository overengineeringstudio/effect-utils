/**
 * React-based Sync Progress UI
 *
 * Replaces the manual ANSI manipulation in sync-ui.ts with declarative React components.
 * Uses @overeng/tui-react for rendering.
 */

import type { SubscriptionRef } from 'effect'
import { Effect, Fiber, Layer, Stream } from 'effect'
import React, { useState, useEffect, useMemo } from 'react'

import { isTTY } from '@overeng/cli-ui'
import {
  Box,
  Text,
  Static,
  TaskList,
  TuiRenderer,
  useSubscriptionRef,
  type TaskItem,
  type TaskStatus,
} from '@overeng/tui-react'

import type { ProgressState, ProgressItem } from './service.ts'
import {
  initSyncProgress,
  SyncProgress,
  SyncProgressEmpty,
  SyncLogs,
  SyncLogsEmpty,
  type SyncItemData,
  type SyncLogEntry,
} from './sync-adapter.ts'

// =============================================================================
// Types
// =============================================================================

/** Handle for managing the sync progress UI lifecycle */
export type SyncProgressUIHandle = {
  /** Fiber running the UI */
  fiber: Fiber.RuntimeFiber<void, never>
  /** Cleanup function */
  cleanup: () => Effect.Effect<void>
}

// =============================================================================
// Formatters
// =============================================================================

const formatElapsed = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.floor(seconds % 60)
  return `${minutes}m${remainingSeconds}s`
}

const mapProgressStatus = (status: ProgressItem['status']): TaskStatus => {
  switch (status) {
    case 'pending':
      return 'pending'
    case 'active':
      return 'active'
    case 'success':
      return 'success'
    case 'error':
      return 'error'
    case 'skipped':
      return 'skipped'
  }
}

const mapProgressItemToTask = (item: ProgressItem<SyncItemData>): TaskItem => ({
  id: item.id,
  label: item.label,
  status: mapProgressStatus(item.status),
  message: item.message,
})

// =============================================================================
// Components
// =============================================================================

/** Header component showing workspace info */
const Header = ({
  title,
  subtitle,
  modes,
}: {
  title: string
  subtitle: string | undefined
  modes: string[] | undefined
}) => (
  <Box>
    <Text bold>{title}</Text>
    {subtitle && <Text dim> {subtitle}</Text>}
    {modes && modes.length > 0 && <Text dim> mode: {modes.join(', ')}</Text>}
    <Text> </Text>
  </Box>
)

/** Log line component for static region */
const LogLine = ({ log }: { log: SyncLogEntry }) => {
  const color = log.type === 'error' ? 'red' : log.type === 'warn' ? 'yellow' : 'cyan'
  const prefix = log.type === 'error' ? '!' : log.type === 'warn' ? '!' : 'i'

  return (
    <Box flexDirection="row">
      <Text color={color}>[{prefix}]</Text>
      <Text dim> {log.message}</Text>
    </Box>
  )
}

/** Summary component */
const Summary = ({ items, startTime }: { items: readonly TaskItem[]; startTime: number }) => {
  const [elapsed, setElapsed] = useState(() => Date.now() - startTime)

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Date.now() - startTime)
    }, 100)
    return () => clearInterval(interval)
  }, [startTime])

  const counts = useMemo(() => {
    let pending = 0
    let active = 0
    let success = 0
    let error = 0
    let skipped = 0
    for (const item of items) {
      switch (item.status) {
        case 'pending':
          pending++
          break
        case 'active':
          active++
          break
        case 'success':
          success++
          break
        case 'error':
          error++
          break
        case 'skipped':
          skipped++
          break
      }
    }
    return { pending, active, success, error, skipped }
  }, [items])

  const total = items.length
  const completed = counts.success + counts.error + counts.skipped

  return (
    <Box paddingTop={1}>
      <Text dim>
        {completed}/{total}
        {counts.error > 0 && (
          <Text color="red">
            {' '}
            · {counts.error} error{counts.error > 1 ? 's' : ''}
          </Text>
        )}
        {' · '}
        {formatElapsed(elapsed)}
      </Text>
    </Box>
  )
}

/** Main sync progress component */
const SyncProgressView = ({
  progressRef,
  logsRef,
  title,
  subtitle,
  modes,
}: {
  progressRef: SubscriptionRef.SubscriptionRef<ProgressState<SyncItemData>>
  logsRef: SubscriptionRef.SubscriptionRef<readonly SyncLogEntry[]>
  title: string
  subtitle: string | undefined
  modes: string[] | undefined
}) => {
  const state = useSubscriptionRef(progressRef)
  const logs = useSubscriptionRef(logsRef)

  const items = useMemo(() => {
    const result: TaskItem[] = []
    for (const item of state.items.values()) {
      result.push(mapProgressItemToTask(item))
    }
    return result
  }, [state.items])

  const isComplete = state.isComplete

  return (
    <>
      {/* Static region: logs */}
      <Static items={logs}>{(log: SyncLogEntry) => <LogLine key={log.id} log={log} />}</Static>

      {/* Dynamic region: header + task list */}
      <Box paddingTop={logs.length > 0 ? 1 : 0}>
        <Header title={title} subtitle={subtitle} modes={modes} />
        <TaskList items={items} />
        {!isComplete && <Summary items={items} startTime={state.startTime} />}
        {isComplete && (
          <Box paddingTop={1}>
            <Text color="green" bold>
              Done
            </Text>
          </Box>
        )}
      </Box>
    </>
  )
}

// =============================================================================
// API
// =============================================================================

/**
 * Start the React-based sync progress UI.
 */
export const startSyncProgressUI = (options: {
  workspaceName: string
  workspaceRoot: string
  memberNames: readonly string[]
  dryRun?: boolean
  frozen?: boolean
  pull?: boolean
  deep?: boolean
}) =>
  Effect.gen(function* () {
    const { workspaceName, workspaceRoot, memberNames, dryRun, frozen, pull, deep } = options

    // Initialize progress state
    yield* initSyncProgress({
      megarepoRoot: workspaceRoot,
      workspaceName,
      memberNames,
    })

    // Build mode indicators
    const modes: string[] = []
    if (dryRun) modes.push('dry run')
    if (frozen) modes.push('frozen')
    if (pull) modes.push('pull')
    if (deep) modes.push('deep')

    // If not TTY, return a no-op handle
    if (!isTTY()) {
      return {
        fiber: yield* Effect.fork(Effect.void),
        cleanup: () => Effect.void,
      } satisfies SyncProgressUIHandle
    }

    // Get the refs
    const progressRef = yield* SyncProgress
    const logsRef = yield* SyncLogs

    // Start TUI renderer
    const tui = yield* TuiRenderer

    yield* tui.render(
      <SyncProgressView
        progressRef={progressRef}
        logsRef={logsRef}
        title={workspaceName}
        subtitle={workspaceRoot}
        modes={modes.length > 0 ? modes : undefined}
      />,
    )

    // Create a fiber that waits for completion
    const completionFiber = yield* progressRef.changes.pipe(
      Stream.takeUntil((state) => state.isComplete),
      Stream.runDrain,
      Effect.fork,
    )

    return {
      fiber: completionFiber,
      cleanup: () => tui.unmount(),
    } satisfies SyncProgressUIHandle
  })

/**
 * Finish the React-based sync progress UI.
 */
export const finishSyncProgressUI = (handle: SyncProgressUIHandle) =>
  Effect.gen(function* () {
    // Wait for completion
    yield* Fiber.join(handle.fiber)
    // Cleanup
    yield* handle.cleanup()
  })

export { isTTY }

// =============================================================================
// Layer
// =============================================================================

/**
 * Layer that provides SyncProgress, SyncLogs, and TuiRenderer.
 * Use this instead of SyncProgressEmpty when using React-based UI.
 */
export const SyncProgressReactLayer = Layer.mergeAll(
  SyncProgressEmpty,
  SyncLogsEmpty,
  TuiRenderer.live,
)
