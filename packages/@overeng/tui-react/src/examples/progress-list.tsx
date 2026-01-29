import React, { useState, useEffect } from 'react'

import { Box, Text, Spinner } from '../mod.ts'

interface Task {
  name: string
  status: 'pending' | 'running' | 'done' | 'error'
}

const StatusIcon = ({ status }: { status: Task['status'] }) => {
  switch (status) {
    case 'pending':
      return <Text dim>○</Text>
    case 'running':
      return <Spinner />
    case 'done':
      return <Text color="green">✓</Text>
    case 'error':
      return <Text color="red">✗</Text>
  }
}

const TaskItem = ({ task }: { task: Task }) => (
  <Box flexDirection="row">
    <StatusIcon status={task.status} />
    <Text color={task.status === 'done' ? 'green' : task.status === 'error' ? 'red' : undefined}>
      {' '}
      {task.name}
    </Text>
  </Box>
)

export interface ProgressListExampleProps {
  /** Title shown above the list */
  title?: string
  /** Items to show in the progress list */
  items?: string[]
  /** Speed multiplier for the simulation (default: 1) */
  speed?: number
}

/**
 * Progress list example - task list with spinners and status icons.
 *
 * Simulates installing dependencies with animated progress.
 */
export const ProgressListExample = ({
  title = 'Installing dependencies...',
  items = ['typescript', 'react', 'effect', 'vitest', 'yoga-layout'],
  speed = 1,
}: ProgressListExampleProps = {}) => {
  const [tasks, setTasks] = useState<Task[]>(() =>
    items.map((name, i) => ({
      name,
      status: i < 2 ? 'done' : i === 2 ? 'running' : 'pending',
    })),
  )

  useEffect(() => {
    let currentIndex = items.findIndex((_, i) => tasks[i]?.status === 'running')
    if (currentIndex === -1) currentIndex = 2

    const interval = setInterval(() => {
      setTasks((prev) => {
        const newTasks = [...prev]

        // Complete current task
        if (newTasks[currentIndex]) {
          newTasks[currentIndex] = { ...newTasks[currentIndex]!, status: 'done' }
        }

        // Start next task
        currentIndex++
        if (currentIndex < newTasks.length && newTasks[currentIndex]) {
          newTasks[currentIndex] = { ...newTasks[currentIndex]!, status: 'running' }
        }

        return newTasks
      })

      // Stop when all done
      if (currentIndex >= tasks.length) {
        clearInterval(interval)
      }
    }, 800 / speed)

    return () => clearInterval(interval)
  }, [speed, tasks.length])

  const doneCount = tasks.filter((t) => t.status === 'done').length

  return (
    <Box>
      <Text bold>{title}</Text>
      <Box paddingLeft={2} paddingTop={1}>
        {tasks.map((task, i) => (
          <TaskItem key={i} task={task} />
        ))}
      </Box>
      <Box paddingTop={1}>
        <Text dim>
          Progress: {doneCount}/{tasks.length}
        </Text>
      </Box>
    </Box>
  )
}
