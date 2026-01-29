import React from 'react'

import { TaskList, type TaskItem } from '../mod.ts'

const items: TaskItem[] = [
  { id: '1', label: 'effect-utils', status: 'success' },
  { id: '2', label: 'livestore', status: 'active', message: 'syncing...' },
  { id: '3', label: 'dotfiles', status: 'pending' },
]

/** Basic TaskList with mixed states */
export const TaskListBasicExample = () => <TaskList items={items} />
