import type { TaskState } from '../../types.ts'
import { TaskStatus } from './TaskStatus.tsx'

/** Props for Task component */
export interface TaskProps {
  task: TaskState
}

/** Renders a single task with status and latest log output in two-column layout */
export const Task = ({ task }: TaskProps) => {
  // Get latest log line for inline display
  const allOutput = [...task.stdout, ...task.stderr]
  const latestLog = allOutput[allOutput.length - 1] || ''

  // Show log for running or failed tasks
  const showLog = (task.status === 'running' || task.status === 'failed') && latestLog.length > 0

  return (
    <box flexDirection="row" width="100%">
      {/* Left column: Status (fixed width) */}
      <box width="50%" flexShrink={0}>
        <TaskStatus task={task} />
      </box>

      {/* Separator */}
      <text fg="gray">│ </text>

      {/* Right column: Latest log (flexible width) */}
      <box flexGrow={1}>
        {showLog && (
          <text fg="gray" dimmed>
            {latestLog.length > 70 ? latestLog.slice(0, 70) + '...' : latestLog}
          </text>
        )}
      </box>
    </box>
  )
}
