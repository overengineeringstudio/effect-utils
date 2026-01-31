import type { Meta, StoryObj } from '@storybook/react'
import React, { useState, useEffect } from 'react'

import { TuiStoryPreview } from '../storybook/TuiStoryPreview.tsx'
import { Box } from './Box.tsx'
import { Static } from './Static.tsx'
import { TaskList, type TaskItem, type TaskStatus } from './TaskList.tsx'
import { Text } from './Text.tsx'

export default {
  title: 'Components/Lists/TaskList',
  component: TaskList,
} satisfies Meta<typeof TaskList>

type Story = StoryObj<typeof TaskList>

/** Basic task list with mixed states */
export const Basic: Story = {
  render: () => (
    <TuiStoryPreview>
      <TaskList
        items={[
          { id: '1', label: 'effect-utils', status: 'success' },
          { id: '2', label: 'livestore', status: 'active', message: 'syncing...' },
          { id: '3', label: 'dotfiles', status: 'pending' },
        ]}
      />
    </TuiStoryPreview>
  ),
}

/** All possible task states */
export const AllStates: Story = {
  render: () => (
    <TuiStoryPreview>
      <TaskList
        items={[
          { id: '1', label: 'pending-task', status: 'pending' },
          { id: '2', label: 'active-task', status: 'active', message: 'working...' },
          { id: '3', label: 'success-task', status: 'success', message: 'done' },
          { id: '4', label: 'error-task', status: 'error', message: 'network failed' },
          { id: '5', label: 'skipped-task', status: 'skipped', message: 'dirty worktree' },
        ]}
        title="All Task States"
        showSummary
        elapsed={5700}
      />
    </TuiStoryPreview>
  ),
}

export const WithTitle: Story = {
  render: (args) => (
    <TuiStoryPreview>
      <TaskList {...args} />
    </TuiStoryPreview>
  ),
  args: {
    items: [
      { id: '1', label: 'effect-utils', status: 'success' },
      { id: '2', label: 'livestore', status: 'active', message: 'syncing...' },
      { id: '3', label: 'dotfiles', status: 'pending' },
    ],
    title: 'Syncing Repositories',
  },
}

/** Task list with summary showing counts and elapsed time */
export const WithSummary: Story = {
  render: () => (
    <TuiStoryPreview>
      <TaskList
        items={[
          { id: '1', label: 'effect-utils', status: 'success' },
          { id: '2', label: 'livestore', status: 'success' },
          { id: '3', label: 'dotfiles', status: 'error', message: 'auth failed' },
          { id: '4', label: 'schickling.dev', status: 'success' },
          { id: '5', label: 'private-repo', status: 'skipped', message: 'not pinned' },
        ]}
        showSummary
        elapsed={12300}
      />
    </TuiStoryPreview>
  ),
}

export const LongList: Story = {
  render: (args) => (
    <TuiStoryPreview>
      <TaskList {...args} />
    </TuiStoryPreview>
  ),
  args: {
    items: Array.from({ length: 15 }, (_, i) => ({
      id: String(i),
      label: `repository-${i + 1}`,
      status: i < 5 ? 'success' : i < 8 ? 'active' : 'pending',
      message: i < 5 ? undefined : i < 8 ? 'syncing...' : undefined,
    })) as TaskItem[],
    title: 'Large Repository Set',
    showSummary: true,
    elapsed: 45000,
  },
}

// =============================================================================
// Sync Simulation - Interactive animated demo
// =============================================================================

type LogEntry = { id: string; message: string; type: 'info' | 'warn' | 'error' }

const SyncSimulationDemo = () => {
  const repos = ['effect', 'effect-utils', 'livestore', 'mr-all-blue', 'dotfiles']
  const [items, setItems] = useState<TaskItem[]>(() =>
    repos.map((label, i) => ({ id: String(i), label, status: 'pending' as TaskStatus })),
  )
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [phase, setPhase] = useState<'running' | 'done'>('running')
  const [elapsed, setElapsed] = useState(0)
  const startTime = Date.now()

  const appendLog = (entry: Omit<LogEntry, 'id'>) => {
    setLogs((prev) => [...prev, { ...entry, id: `log-${Date.now()}` }])
  }

  // Simulate processing
  useEffect(() => {
    if (phase !== 'running') return

    const processItem = (index: number) => {
      if (index >= items.length) {
        setPhase('done')
        return
      }

      setItems((prev) =>
        prev.map((item, i) =>
          i === index ? { ...item, status: 'active' as TaskStatus, message: 'syncing...' } : item,
        ),
      )

      setTimeout(
        () => {
          const rand = Math.random()
          let status: TaskStatus
          let message: string | undefined

          if (rand < 0.7) {
            status = 'success'
            message = 'synced (main)'
          } else if (rand < 0.85) {
            status = 'success'
          } else if (rand < 0.95) {
            status = 'skipped'
            message = 'dirty worktree'
            appendLog({ message: `${repos[index]}: skipped - dirty worktree`, type: 'warn' })
          } else {
            status = 'error'
            message = 'network error'
            appendLog({ message: `${repos[index]}: error - network error`, type: 'error' })
          }

          setItems((prev) =>
            prev.map((item, i) => (i === index ? { ...item, status, message } : item)),
          )
          processItem(index + 1)
        },
        300 + Math.random() * 400,
      )
    }

    processItem(0)
  }, [phase])

  useEffect(() => {
    if (phase !== 'running') return
    const interval = setInterval(() => setElapsed(Date.now() - startTime), 100)
    return () => clearInterval(interval)
  }, [phase, startTime])

  return (
    <>
      <Static items={logs}>
        {(log: LogEntry) => (
          <Box key={log.id} flexDirection="row">
            <Text color={log.type === 'error' ? 'red' : 'yellow'}>
              [{log.type === 'error' ? '!' : '!'}]
            </Text>
            <Text dim> {log.message}</Text>
          </Box>
        )}
      </Static>
      <Box paddingTop={logs.length > 0 ? 1 : 0}>
        <Text bold>my-workspace</Text>
        <Text dim> /Users/test/workspace</Text>
        <Text> </Text>
        <TaskList items={items} showSummary elapsed={elapsed} />
        {phase === 'done' && (
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

/** Interactive sync simulation (animated in terminal) */
export const SyncSimulation: Story = {
  render: () => (
    <TuiStoryPreview>
      <SyncSimulationDemo />
    </TuiStoryPreview>
  ),
}

export const InContext: Story = {
  render: () => (
    <TuiStoryPreview>
      <Box>
        <Box flexDirection="row">
          <Text bold>mr sync</Text>
          <Text dim> schickling/megarepo-all</Text>
        </Box>
        <Box paddingTop={1}>
          <TaskList
            items={[
              { id: '1', label: 'effect-utils', status: 'success' },
              { id: '2', label: 'livestore', status: 'active', message: 'pulling...' },
              { id: '3', label: 'dotfiles', status: 'pending' },
            ]}
            showSummary
            elapsed={2100}
          />
        </Box>
      </Box>
    </TuiStoryPreview>
  ),
}
