import type { TaskState } from '../../types.ts'
import { Task } from './Task.tsx'

/** Props for TaskList component */
export interface TaskListProps {
  tasks: TaskState[]
}

/** Renders a vertical list of tasks */
export const TaskList = ({ tasks }: TaskListProps) => {
  return (
    <box flexDirection="column">
      {tasks.map((task) => (
        <Task key={task.id} task={task} />
      ))}
    </box>
  )
}
