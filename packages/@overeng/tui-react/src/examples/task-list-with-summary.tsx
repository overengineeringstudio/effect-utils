import React from 'react'

import { TaskList, type TaskItem } from '../mod.ts'

const items: TaskItem[] = [
  { id: '1', label: 'effect-utils', status: 'success' },
  { id: '2', label: 'livestore', status: 'success' },
  { id: '3', label: 'dotfiles', status: 'error', message: 'auth failed' },
  { id: '4', label: 'schickling.dev', status: 'success' },
  { id: '5', label: 'private-repo', status: 'skipped', message: 'not pinned' },
]

/** TaskList with summary line showing counts and elapsed time */
export const TaskListWithSummaryExample = () => (
  <TaskList items={items} showSummary elapsed={12300} />
)
