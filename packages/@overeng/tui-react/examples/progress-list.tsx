/**
 * Progress list example - task list with spinners and status icons.
 *
 * Run: npx tsx examples/progress-list.tsx
 */

import React, { useState, useEffect } from 'react'
import { createRoot, Box, Text, Spinner } from '../src/mod.ts'

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
      {' '}{task.name}
    </Text>
  </Box>
)

const App = () => {
  const [tasks, setTasks] = useState<Task[]>([
    { name: 'typescript', status: 'done' },
    { name: 'react', status: 'done' },
    { name: 'effect', status: 'running' },
    { name: 'vitest', status: 'pending' },
    { name: 'yoga-layout', status: 'pending' },
  ])

  useEffect(() => {
    let currentIndex = 2 // Start with 'effect' which is running

    const interval = setInterval(() => {
      setTasks(prev => {
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
    }, 800)

    return () => clearInterval(interval)
  }, [])

  const doneCount = tasks.filter(t => t.status === 'done').length

  return (
    <Box>
      <Text bold>Installing dependencies...</Text>
      <Box paddingLeft={2} paddingTop={1}>
        {tasks.map((task, i) => (
          <TaskItem key={i} task={task} />
        ))}
      </Box>
      <Box paddingTop={1}>
        <Text dim>Progress: {doneCount}/{tasks.length}</Text>
      </Box>
    </Box>
  )
}

const root = createRoot(process.stdout)
root.render(<App />)

// Exit after tasks complete
setTimeout(() => {
  root.unmount()
  process.exit(0)
}, 5000)
