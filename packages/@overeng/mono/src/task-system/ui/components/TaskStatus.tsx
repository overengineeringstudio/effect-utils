import type { TaskState } from '../../types.ts'
import { Option } from 'effect'
import { useEffect, useState } from 'react'

export interface TaskStatusProps {
  task: TaskState
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export const TaskStatus = ({ task }: TaskStatusProps) => {
  const [spinnerFrame, setSpinnerFrame] = useState(0)

  // Animated spinner for running/pending tasks
  useEffect(() => {
    if (task.status === 'running' || task.status === 'pending') {
      const interval = setInterval(() => {
        setSpinnerFrame((prev) => (prev + 1) % SPINNER_FRAMES.length)
      }, 80)
      return () => clearInterval(interval)
    }
  }, [task.status])

  const getIcon = (): string => {
    if (task.status === 'pending') return SPINNER_FRAMES[spinnerFrame]!
    if (task.status === 'running') return SPINNER_FRAMES[spinnerFrame]!
    if (task.status === 'success') return '✓'
    if (task.status === 'failed') return '✗'
    return '○' // fallback
  }

  const color = {
    pending: 'white',
    running: 'cyan',
    success: 'green',
    failed: 'red',
  }[task.status]

  const duration = Option.match(task.startedAt, {
    onNone: () => '',
    onSome: (start) =>
      Option.match(task.completedAt, {
        onNone: () => ` (${((Date.now() - start) / 1000).toFixed(1)}s)`,
        onSome: (end) => ` (${((end - start) / 1000).toFixed(1)}s)`,
      }),
  })

  // Show retry info if retrying
  const retryInfo = Option.match(task.maxRetries, {
    onNone: () => '',
    onSome: (maxRetries) =>
      task.retryAttempt > 0 ? ` [retry ${task.retryAttempt}/${maxRetries}]` : '',
  })

  return (
    <text fg={color}>
      {getIcon()} {task.name}
      {duration}
      {retryInfo}
    </text>
  )
}
