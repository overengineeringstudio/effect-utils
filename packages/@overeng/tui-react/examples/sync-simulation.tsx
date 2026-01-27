/**
 * Sync simulation - simulates `mr sync --deep` with nested repos, warnings, and completion.
 *
 * This is the KEY example demonstrating real-world usage of the TUI library:
 * - Static logs for completed repo syncs (with warnings/errors)
 * - Dynamic progress showing current operations
 * - Nested repo hierarchy
 * - Mixed success/warning/error states
 *
 * Run: npx tsx examples/sync-simulation.tsx
 */

import React, { useState, useEffect } from 'react'
import { createRoot, Box, Text, Static, Spinner } from '../src/mod.ts'

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
        {' '}{log.path}
      </Text>
      {log.message && (
        <Text color={log.status === 'error' ? 'red' : 'yellow'} dim>
          {' '}({log.message})
        </Text>
      )}
    </Box>
  )
}

const ActiveRepoLine = ({ repo, isLast }: { repo: Repo; isLast: boolean }) => {
  const indent = '  '.repeat(repo.depth)
  return (
    <Box flexDirection="row">
      <Text>{indent}</Text>
      <StatusIcon status={repo.status} />
      <Text bold={repo.status === 'syncing'}>
        {' '}{repo.path}
      </Text>
      {repo.status === 'syncing' && (
        <Text dim> fetching...</Text>
      )}
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

const App = () => {
  const [workspace, setWorkspace] = useState<Repo[]>(createWorkspace)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [phase, setPhase] = useState<'scanning' | 'syncing' | 'done'>('scanning')
  const [logId, setLogId] = useState(0)

  useEffect(() => {
    // Phase 1: Scanning (brief)
    const scanTimeout = setTimeout(() => {
      setPhase('syncing')
    }, 800)

    return () => clearTimeout(scanTimeout)
  }, [])

  useEffect(() => {
    if (phase !== 'syncing') return

    const allRepos = flattenRepos(workspace)
    let currentIndex = 0
    const maxConcurrent = 3
    let completed = 0

    const processNext = () => {
      // Start new repos up to max concurrent
      const syncing = flattenRepos(workspace).filter(r => r.status === 'syncing').length
      const toStart = Math.min(maxConcurrent - syncing, allRepos.length - currentIndex)

      if (toStart > 0) {
        setWorkspace(prev => {
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
      setWorkspace(prev => {
        const newWorkspace = JSON.parse(JSON.stringify(prev)) as Repo[]
        const flat = flattenRepos(newWorkspace)
        
        // Complete one syncing repo
        const syncingRepo = flat.find(r => r.status === 'syncing')
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
          setLogs(prevLogs => [...prevLogs, {
            id: logId + prevLogs.length,
            path: syncingRepo.path,
            status: syncingRepo.status as 'done' | 'warning' | 'error',
            message: syncingRepo.message,
            depth: syncingRepo.depth,
          }])

          completed++

          // Start next repo
          const pending = flat.find(r => r.status === 'pending')
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
    }, 300)

    return () => clearInterval(interval)
  }, [phase, logId])

  const allRepos = flattenRepos(workspace)
  const syncingRepos = allRepos.filter(r => r.status === 'syncing')
  const pendingRepos = allRepos.filter(r => r.status === 'pending')
  const doneCount = logs.filter(l => l.status === 'done').length
  const warningCount = logs.filter(l => l.status === 'warning').length
  const errorCount = logs.filter(l => l.status === 'error').length

  return (
    <>
      {/* Static region: completed repos */}
      <Static items={logs}>
        {(log) => <LogLine key={log.id} log={log} />}
      </Static>

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
                {syncingRepos.map((repo, i) => (
                  <ActiveRepoLine 
                    key={repo.path} 
                    repo={repo} 
                    isLast={i === syncingRepos.length - 1}
                  />
                ))}
              </Box>
            )}
            
            {pendingRepos.length > 0 && (
              <Text dim>
                {pendingRepos.length} repositories queued...
              </Text>
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

const root = createRoot(process.stdout)
root.render(<App />)

// Exit after completion
setTimeout(() => {
  root.unmount()
  process.exit(0)
}, 15000)
