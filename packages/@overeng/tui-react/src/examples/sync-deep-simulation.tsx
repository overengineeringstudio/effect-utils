/**
 * Deep sync simulation - simulates `mr sync --deep` with nested repos, warnings, and completion.
 *
 * This is a complex example demonstrating real-world usage of the TUI library:
 * - Static logs for completed repo syncs (with warnings/errors)
 * - Dynamic progress showing current operations
 * - Nested repo hierarchy
 * - Mixed success/warning/error states
 */

import React, { useState, useEffect } from 'react'

import { Box, Text, Static, Spinner } from '../mod.ts'

type RepoStatus = 'pending' | 'syncing' | 'done' | 'warning' | 'error'

interface Repo {
  path: string
  depth: number
  status: RepoStatus
  message?: string
  children?: Repo[]
}

interface LogEntry {
  id: number
  path: string
  status: 'done' | 'warning' | 'error'
  message?: string
  depth: number
}

// Simulated workspace structure
const createWorkspace = (): Repo[] => [
  {
    path: 'apps/web',
    depth: 0,
    status: 'pending',
    children: [
      { path: 'apps/web/packages/ui', depth: 1, status: 'pending' },
      { path: 'apps/web/packages/api-client', depth: 1, status: 'pending' },
    ],
  },
  {
    path: 'apps/mobile',
    depth: 0,
    status: 'pending',
    message: 'uncommitted changes',
  },
  {
    path: 'libs/core',
    depth: 0,
    status: 'pending',
    children: [
      { path: 'libs/core/effect-utils', depth: 1, status: 'pending' },
      { path: 'libs/core/shared-types', depth: 1, status: 'pending' },
    ],
  },
  {
    path: 'libs/ui',
    depth: 0,
    status: 'pending',
  },
  {
    path: 'tools/cli',
    depth: 0,
    status: 'pending',
  },
  {
    path: 'tools/scripts',
    depth: 0,
    status: 'pending',
    message: 'remote not found',
  },
  {
    path: 'infra/terraform',
    depth: 0,
    status: 'pending',
    children: [
      { path: 'infra/terraform/modules/vpc', depth: 1, status: 'pending' },
      { path: 'infra/terraform/modules/eks', depth: 1, status: 'pending' },
    ],
  },
]

const StatusIcon = ({ status }: { status: RepoStatus }) => {
  switch (status) {
    case 'pending':
      return <Text dim>○</Text>
    case 'syncing':
      return <Spinner />
    case 'done':
      return <Text color="green">✓</Text>
    case 'warning':
      return <Text color="yellow">!</Text>
    case 'error':
      return <Text color="red">✗</Text>
  }
}

const LogLine = ({ log }: { log: LogEntry }) => {
  const indent = '  '.repeat(log.depth)
  return (
    <Box flexDirection="row">
      <Text>{indent}</Text>
      <StatusIcon status={log.status} />
      <Text color={log.status === 'error' ? 'red' : log.status === 'warning' ? 'yellow' : 'green'}>
        {' '}
        {log.path}
      </Text>
      {log.message && (
        <Text color={log.status === 'error' ? 'red' : 'yellow'} dim>
          {' '}
          ({log.message})
        </Text>
      )}
    </Box>
  )
}

const ActiveRepoLine = ({ repo }: { repo: Repo }) => {
  const indent = '  '.repeat(repo.depth)
  return (
    <Box flexDirection="row">
      <Text>{indent}</Text>
      <StatusIcon status={repo.status} />
      <Text bold={repo.status === 'syncing'}> {repo.path}</Text>
      {repo.status === 'syncing' && <Text dim> fetching...</Text>}
    </Box>
  )
}

const flattenRepos = (repos: Repo[]): Repo[] => {
  const result: Repo[] = []
  for (const repo of repos) {
    result.push(repo)
    if (repo.children) {
      result.push(...flattenRepos(repo.children))
    }
  }
  return result
}

/** Deep sync phase states */
export type SyncDeepPhase = 'scanning' | 'syncing' | 'done'

/** Current sync state for controlling the simulation */
export interface SyncDeepState {
  /** Current phase of the sync */
  phase: SyncDeepPhase
  /** Number of completed repos (0 to total) */
  completedCount: number
}

export interface SyncDeepSimulationExampleProps {
  /** Speed multiplier for the simulation (default: 1) */
  speed?: number
  /** Maximum concurrent repos syncing at once (default: 3) */
  maxConcurrent?: number
  /** Whether to auto-run the simulation (default: true) */
  autoRun?: boolean
  /** Control the sync state directly (only used when autoRun is false) */
  syncState?: SyncDeepState
}

/** Compute static state for controlled mode */
const computeStaticState = ({
  baseWorkspace,
  state,
  maxConcurrent,
}: {
  baseWorkspace: Repo[]
  state: SyncDeepState
  maxConcurrent: number
}): { workspace: Repo[]; logs: LogEntry[] } => {
  const { phase, completedCount } = state

  if (phase === 'scanning') {
    return { workspace: baseWorkspace, logs: [] }
  }

  const workspace = JSON.parse(JSON.stringify(baseWorkspace)) as Repo[]
  const flat = flattenRepos(workspace)
  const logs: LogEntry[] = []

  // Mark repos based on completedCount
  for (let i = 0; i < flat.length; i++) {
    const repo = flat[i]!
    if (i < completedCount) {
      // Completed
      if (repo.message?.includes('uncommitted')) {
        repo.status = 'warning'
      } else if (repo.message?.includes('not found')) {
        repo.status = 'error'
      } else {
        repo.status = 'done'
      }
      const logEntry: LogEntry = {
        id: i,
        path: repo.path,
        status: repo.status as 'done' | 'warning' | 'error',
        depth: repo.depth,
      }
      if (repo.message) {
        logEntry.message = repo.message
      }
      logs.push(logEntry)
    } else if (phase === 'done') {
      // All done
      repo.status = 'done'
      logs.push({
        id: i,
        path: repo.path,
        status: 'done',
        depth: repo.depth,
      })
    } else if (i < completedCount + maxConcurrent) {
      // Currently syncing (up to maxConcurrent)
      repo.status = 'syncing'
    } else {
      repo.status = 'pending'
    }
  }

  return { workspace, logs }
}

/**
 * Deep sync simulation with nested repositories and static log region.
 */
export const SyncDeepSimulationExample = ({
  speed = 1,
  maxConcurrent = 3,
  autoRun = true,
  syncState,
}: SyncDeepSimulationExampleProps = {}) => {
  const baseWorkspace = createWorkspace()

  // Compute initial state based on mode
  const initialState =
    !autoRun && syncState
      ? computeStaticState({ baseWorkspace, state: syncState, maxConcurrent })
      : { workspace: baseWorkspace, logs: [] as LogEntry[] }

  const [workspace, setWorkspace] = useState<Repo[]>(initialState.workspace)
  const [logs, setLogs] = useState<LogEntry[]>(initialState.logs)
  const [phase, setPhase] = useState<SyncDeepPhase>(
    !autoRun && syncState ? syncState.phase : 'scanning',
  )
  const [logId, setLogId] = useState(0)

  // Update state when syncState changes (controlled mode)
  useEffect(() => {
    if (!autoRun && syncState) {
      const computed = computeStaticState({ baseWorkspace, state: syncState, maxConcurrent })
      setWorkspace(computed.workspace)
      setLogs(computed.logs)
      setPhase(syncState.phase)
    }
  }, [autoRun, syncState?.phase, syncState?.completedCount, maxConcurrent])

  useEffect(() => {
    if (!autoRun) return

    // Phase 1: Scanning (brief)
    const scanTimeout = setTimeout(() => {
      setPhase('syncing')
    }, 800 / speed)

    return () => clearTimeout(scanTimeout)
  }, [autoRun, speed])

  useEffect(() => {
    if (!autoRun || phase !== 'syncing') return

    const allRepos = flattenRepos(workspace)
    let currentIndex = 0
    let completed = 0

    const processNext = () => {
      // Start new repos up to max concurrent
      const syncing = flattenRepos(workspace).filter((r) => r.status === 'syncing').length
      const toStart = Math.min(maxConcurrent - syncing, allRepos.length - currentIndex)

      if (toStart > 0) {
        setWorkspace((prev) => {
          const newWorkspace = JSON.parse(JSON.stringify(prev)) as Repo[]
          const flat = flattenRepos(newWorkspace)

          for (let i = 0; i < toStart && currentIndex + i < flat.length; i++) {
            const repo = flat[currentIndex + i]
            if (repo && repo.status === 'pending') {
              repo.status = 'syncing'
            }
          }

          return newWorkspace
        })
        currentIndex += toStart
      }
    }

    // Start initial batch
    processNext()

    const interval = setInterval(() => {
      setWorkspace((prev) => {
        const newWorkspace = JSON.parse(JSON.stringify(prev)) as Repo[]
        const flat = flattenRepos(newWorkspace)

        // Complete one syncing repo
        const syncingRepo = flat.find((r) => r.status === 'syncing')
        if (syncingRepo) {
          // Determine final status
          if (syncingRepo.message?.includes('uncommitted')) {
            syncingRepo.status = 'warning'
          } else if (syncingRepo.message?.includes('not found')) {
            syncingRepo.status = 'error'
          } else {
            syncingRepo.status = Math.random() > 0.9 ? 'warning' : 'done'
            if (syncingRepo.status === 'warning' && !syncingRepo.message) {
              syncingRepo.message = 'behind remote by 2 commits'
            }
          }

          // Add to logs
          setLogs((prevLogs) => {
            const newLogEntry: LogEntry = {
              id: logId + prevLogs.length,
              path: syncingRepo.path,
              status: syncingRepo.status as 'done' | 'warning' | 'error',
              depth: syncingRepo.depth,
            }
            if (syncingRepo.message) {
              newLogEntry.message = syncingRepo.message
            }
            return [...prevLogs, newLogEntry]
          })

          completed++

          // Start next repo
          const pending = flat.find((r) => r.status === 'pending')
          if (pending) {
            pending.status = 'syncing'
          }

          // Check if all done
          if (completed >= flat.length) {
            setPhase('done')
          }
        }

        return newWorkspace
      })
    }, 300 / speed)

    return () => clearInterval(interval)
  }, [autoRun, phase, logId, speed, maxConcurrent])

  const allRepos = flattenRepos(workspace)
  const syncingRepos = allRepos.filter((r) => r.status === 'syncing')
  const pendingRepos = allRepos.filter((r) => r.status === 'pending')
  const doneCount = logs.filter((l) => l.status === 'done').length
  const warningCount = logs.filter((l) => l.status === 'warning').length
  const errorCount = logs.filter((l) => l.status === 'error').length

  return (
    <>
      {/* Static region: completed repos */}
      <Static items={logs}>{(log) => <LogLine key={log.id} log={log} />}</Static>

      {/* Dynamic region: header + active operations */}
      <Box paddingTop={logs.length > 0 ? 1 : 0}>
        {phase === 'scanning' && (
          <Box flexDirection="row">
            <Spinner />
            <Text> Scanning workspace for repositories...</Text>
          </Box>
        )}

        {phase === 'syncing' && (
          <>
            {syncingRepos.length > 0 && (
              <Box>
                {syncingRepos.map((repo) => (
                  <ActiveRepoLine key={repo.path} repo={repo} />
                ))}
              </Box>
            )}

            {pendingRepos.length > 0 && (
              <Text dim>{pendingRepos.length} repositories queued...</Text>
            )}
          </>
        )}

        {phase === 'done' && (
          <Box>
            <Text color={errorCount > 0 ? 'red' : warningCount > 0 ? 'yellow' : 'green'} bold>
              {errorCount > 0 ? '✗' : '✓'} Sync complete
            </Text>
            <Box paddingLeft={2}>
              <Text color="green">{doneCount} synced</Text>
              {warningCount > 0 && <Text color="yellow">{warningCount} warnings</Text>}
              {errorCount > 0 && <Text color="red">{errorCount} errors</Text>}
            </Box>
          </Box>
        )}

        {/* Footer summary during sync */}
        {phase === 'syncing' && (
          <Box paddingTop={1}>
            <Text dim>
              Progress: {logs.length}/{allRepos.length} repositories
              {warningCount > 0 && <Text color="yellow"> ({warningCount} warnings)</Text>}
              {errorCount > 0 && <Text color="red"> ({errorCount} errors)</Text>}
            </Text>
          </Box>
        )}
      </Box>
    </>
  )
}
