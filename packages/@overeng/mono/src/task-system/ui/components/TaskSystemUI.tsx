import type { Atom } from '@effect-atom/atom'
import { useAtomValue } from '@effect-atom/atom-react'

import type { TaskSystemState } from '../../types.ts'
import { TaskList } from './TaskList.tsx'

/** Props for TaskSystemUI component */
export interface TaskSystemUIProps {
  atom: Atom.Atom<TaskSystemState>
}

/** Renders the task system state from an atom */
export const TaskSystemUI = ({ atom }: TaskSystemUIProps) => {
  const state = useAtomValue(atom)
  const tasks = Object.values(state.tasks)

  return (
    <box flexDirection="column" padding={1}>
      <TaskList tasks={tasks} />
    </box>
  )
}
