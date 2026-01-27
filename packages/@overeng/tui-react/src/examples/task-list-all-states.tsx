import React from 'react'
import { TaskList, type TaskItem } from '../mod.ts'

const items: TaskItem[] = [
  { id: '1', label: 'pending-task', status: 'pending' },
  { id: '2', label: 'active-task', status: 'active', message: 'working...' },
  { id: '3', label: 'success-task', status: 'success', message: 'done' },
  { id: '4', label: 'error-task', status: 'error', message: 'network failed' },
  { id: '5', label: 'skipped-task', status: 'skipped', message: 'dirty worktree' },
]

/** TaskList showing all possible states */
export const TaskListAllStatesExample = () => (
  <TaskList items={items} title="All Task States" showSummary elapsed={5700} />
)
