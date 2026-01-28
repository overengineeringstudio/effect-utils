import React, { useState, useEffect } from 'react'
import { Box, Text, Static, TaskList, type TaskItem, type TaskStatus } from '../mod.ts'

type LogEntry = {
  id: string
  message: string
  type: 'info' | 'warn' | 'error'
}

/** Sync phase states */
export type SyncPhase = 'running' | 'done'

/** Current sync state for controlling the simulation */
export interface SyncState {
  /** Current phase of the sync */
  phase: SyncPhase
  /** Index of the currently active task (0-based), -1 for none */
  activeIndex: number
}

export interface SyncSimulationProps {
  /** Repository names to simulate syncing */
  repos?: string[]
  /** Workspace name shown in header */
  workspaceName?: string
  /** Workspace path shown in header */
  workspacePath?: string
  /** Whether to auto-run the simulation (default: true) */
  autoRun?: boolean
  /** Control the sync state directly (only used when autoRun is false) */
  syncState?: SyncState
}

/**
 * Interactive sync simulation example.
 *
 * Shows a header, task list with progress, and logs.
 * Simulates repository syncing with random success/error states.
 */
export const SyncSimulationExample = ({
  repos = ['effect', 'effect-utils', 'livestore', 'mr-all-blue', 'dotfiles'],
  workspaceName = 'my-workspace',
  workspacePath = '/Users/test/workspace',
  autoRun = true,
  syncState,
}: SyncSimulationProps) => {
  // Compute items based on syncState when not auto-running
  const computeItemsFromState = (state: SyncState | undefined): TaskItem[] => {
    return repos.map((label, i) => {
      if (!state || autoRun) {
        return { id: String(i), label, status: 'pending' as TaskStatus }
      }
      
      const { phase, activeIndex } = state
      let status: TaskStatus
      let message: string | undefined
      
      if (phase === 'done') {
        // All items completed
        status = 'success'
        message = 'synced (main)'
      } else if (i < activeIndex) {
        // Completed items
        status = 'success'
        message = 'synced (main)'
      } else if (i === activeIndex) {
        // Currently active item
        status = 'active'
        message = 'syncing...'
      } else {
        // Pending items
        status = 'pending'
      }
      
      return { id: String(i), label, status, message }
    })
  }

  const [items, setItems] = useState<TaskItem[]>(() => computeItemsFromState(syncState))
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [phase, setPhase] = useState<SyncPhase>(syncState?.phase ?? 'running')
  const [elapsed, setElapsed] = useState(0)
  const startTime = Date.now()

  // Update items when syncState changes (for controlled mode)
  useEffect(() => {
    if (!autoRun && syncState) {
      setItems(computeItemsFromState(syncState))
      setPhase(syncState.phase)
    }
  }, [autoRun, syncState?.phase, syncState?.activeIndex, repos.join(',')])

  const appendLog = (entry: Omit<LogEntry, 'id'>) => {
    const id = `log-${Date.now()}`
    setLogs(prev => [...prev, { ...entry, id }])
  }

  // Simulate processing (only when autoRun is true)
  useEffect(() => {
    if (!autoRun || phase !== 'running') return

    const processItem = (index: number) => {
      if (index >= items.length) {
        setPhase('done')
        return
      }

      // Mark current as active
      setItems(prev => prev.map((item, i) =>
        i === index ? { ...item, status: 'active' as TaskStatus, message: 'syncing...' } : item
      ))

      // After a delay, mark as complete
      setTimeout(() => {
        const rand = Math.random()
        let status: TaskStatus
        let message: string | undefined

        if (rand < 0.7) {
          status = 'success'
          message = 'synced (main)'
        } else if (rand < 0.85) {
          status = 'success'
          message = undefined
        } else if (rand < 0.95) {
          status = 'skipped'
          message = 'dirty worktree'
          appendLog({
            message: `${items[index]!.label}: skipped - dirty worktree`,
            type: 'warn',
          })
        } else {
          status = 'error'
          message = 'network error'
          appendLog({
            message: `${items[index]!.label}: error - network error`,
            type: 'error',
          })
        }

        setItems(prev => prev.map((item, i) =>
          i === index ? { ...item, status, message } : item
        ))

        processItem(index + 1)
      }, 300 + Math.random() * 400)
    }

    processItem(0)
  }, [autoRun, phase])

  // Update elapsed time
  useEffect(() => {
    if (phase !== 'running') return
    const interval = setInterval(() => {
      setElapsed(Date.now() - startTime)
    }, 100)
    return () => clearInterval(interval)
  }, [phase, startTime])

  const LogLine = ({ log }: { log: LogEntry }) => {
    const color = log.type === 'error' ? 'red' : log.type === 'warn' ? 'yellow' : 'cyan'
    const prefix = log.type === 'error' ? '!' : log.type === 'warn' ? '!' : 'i'
    return (
      <Box flexDirection="row">
        <Text color={color}>[{prefix}]</Text>
        <Text dim> {log.message}</Text>
      </Box>
    )
  }

  return (
    <>
      {/* Static region: logs */}
      <Static items={logs}>
        {(log: LogEntry) => <LogLine key={log.id} log={log} />}
      </Static>

      {/* Dynamic region */}
      <Box paddingTop={logs.length > 0 ? 1 : 0}>
        {/* Header */}
        <Text bold>{workspaceName}</Text>
        <Text dim>  {workspacePath}</Text>
        <Text dim>  mode: pull</Text>
        <Text> </Text>

        {/* Task list */}
        <TaskList items={items} showSummary elapsed={elapsed} />

        {/* Completion message */}
        {phase === 'done' && (
          <Box paddingTop={1}>
            <Text color="green" bold>Done</Text>
          </Box>
        )}
      </Box>
    </>
  )
}
