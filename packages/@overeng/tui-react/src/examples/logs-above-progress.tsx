import React, { useState, useEffect } from 'react'

import { Box, Text, Static, Spinner } from '../mod.ts'

interface LogEntry {
  id: number
  timestamp: string
  level: 'info' | 'warn' | 'error'
  message: string
}

const LogLine = ({ log }: { log: LogEntry }) => {
  const levelColors = {
    info: 'cyan',
    warn: 'yellow',
    error: 'red',
  } as const

  const levelIcons = {
    info: 'i',
    warn: '!',
    error: '✗',
  }

  return (
    <Box flexDirection="row">
      <Text dim>[{log.timestamp}]</Text>
      <Text color={levelColors[log.level]}> {levelIcons[log.level]} </Text>
      <Text color={log.level === 'error' ? 'red' : undefined}>{log.message}</Text>
    </Box>
  )
}

export interface LogsAboveProgressExampleProps {
  /** Speed multiplier for the simulation (default: 1) */
  speed?: number
}

/**
 * Logs above progress example - demonstrates the key <Static> component feature.
 *
 * The <Static> component renders items once to a "static region" that persists
 * above the dynamic content. This is how logs appear above progress indicators.
 */
export const LogsAboveProgressExample = ({ speed = 1 }: LogsAboveProgressExampleProps = {}) => {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [currentTask, setCurrentTask] = useState('Initializing...')
  const [progress, setProgress] = useState(0)
  const totalSteps = 10

  useEffect(() => {
    let step = 0
    let logId = 0

    const tasks = [
      'Scanning workspace...',
      'Loading configuration...',
      'Analyzing dependencies...',
      'Checking remote status...',
      'Fetching updates...',
      'Validating changes...',
      'Applying transforms...',
      'Running checks...',
      'Generating output...',
      'Finalizing...',
    ]

    const logMessages: Array<{ level: LogEntry['level']; message: string }> = [
      { level: 'info', message: 'Found 12 repositories in workspace' },
      { level: 'info', message: 'Config loaded from .mr/config.yaml' },
      { level: 'warn', message: 'Repo "legacy-api" has uncommitted changes' },
      { level: 'info', message: 'Dependencies resolved: 156 packages' },
      { level: 'info', message: 'Remote: origin/main is 3 commits ahead' },
      { level: 'error', message: 'Failed to fetch from "deprecated-service" (timeout)' },
      { level: 'info', message: 'Fetched 45 objects from 11 remotes' },
      { level: 'info', message: 'All changes validated successfully' },
      { level: 'warn', message: 'Transform "lint-fix" modified 8 files' },
      { level: 'info', message: 'Pre-commit hooks passed' },
      { level: 'info', message: 'Output written to .mr/report.json' },
      { level: 'info', message: 'Operation completed successfully' },
    ]

    const interval = setInterval(() => {
      // Add a log entry
      const timestamp = new Date().toISOString().split('T')[1]?.slice(0, 8) ?? '00:00:00'

      if (step < logMessages.length) {
        const logMsg = logMessages[step]
        if (logMsg) {
          setLogs((prev) => [
            ...prev,
            {
              id: logId++,
              timestamp,
              level: logMsg.level,
              message: logMsg.message,
            },
          ])
        }
      }

      // Update progress
      if (step < totalSteps) {
        setProgress(step + 1)
        const task = tasks[step]
        if (task) {
          setCurrentTask(task)
        }
      }

      step++

      if (step > totalSteps) {
        clearInterval(interval)
        setCurrentTask('Done!')
      }
    }, 400 / speed)

    return () => clearInterval(interval)
  }, [speed])

  const isDone = progress >= totalSteps

  return (
    <>
      {/* Static region: logs are rendered once and persist above */}
      <Static items={logs}>{(log) => <LogLine key={log.id} log={log} />}</Static>

      {/* Dynamic region: progress updates in place */}
      <Box paddingTop={logs.length > 0 ? 1 : 0}>
        <Box flexDirection="row">
          {isDone ? (
            <Text color="green" bold>
              ✓{' '}
            </Text>
          ) : (
            <>
              <Spinner />
              <Text> </Text>
            </>
          )}
          <Text bold={!isDone} color={isDone ? 'green' : undefined}>
            {currentTask}
          </Text>
        </Box>
        {!isDone && (
          <Box paddingLeft={2}>
            <Text dim>
              Step {progress}/{totalSteps} ({Math.round((progress / totalSteps) * 100)}%)
            </Text>
          </Box>
        )}
      </Box>
    </>
  )
}
