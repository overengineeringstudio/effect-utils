/**
 * Tests for TaskList component
 */

import { describe, test, expect } from 'vitest'
import React from 'react'
import { createRoot, TaskList, type TaskItem } from '../../src/mod.ts'
import { createMockTerminal } from '../helpers/mod.ts'

describe('TaskList', () => {
  test('renders items with correct status icons', async () => {
    const terminal = createMockTerminal()
    const root = createRoot(terminal)

    const items: TaskItem[] = [
      { id: '1', label: 'Task 1', status: 'success' },
      { id: '2', label: 'Task 2', status: 'error', message: 'failed!' },
      { id: '3', label: 'Task 3', status: 'pending' },
      { id: '4', label: 'Task 4', status: 'skipped', message: 'skipped' },
    ]

    root.render(<TaskList items={items} />)
    await new Promise((r) => setTimeout(r, 50))

    const output = terminal.getPlainOutput()
    
    // Check for success icon (green checkmark)
    expect(output).toContain('✓')
    expect(output).toContain('Task 1')
    
    // Check for error icon (red cross)
    expect(output).toContain('✗')
    expect(output).toContain('Task 2')
    expect(output).toContain('failed!')
    
    // Check for pending icon
    expect(output).toContain('○')
    expect(output).toContain('Task 3')
    
    // Check for skipped icon
    expect(output).toContain('-')
    expect(output).toContain('Task 4')

    root.unmount()
  })

  test('renders active item with spinner', async () => {
    const terminal = createMockTerminal()
    const root = createRoot(terminal)

    const items: TaskItem[] = [
      { id: '1', label: 'Building', status: 'active', message: 'compiling...' },
    ]

    root.render(<TaskList items={items} />)
    await new Promise((r) => setTimeout(r, 50))

    const output = terminal.getPlainOutput()
    
    // Spinner character (one of the dots frames)
    expect(output).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)
    expect(output).toContain('Building')
    expect(output).toContain('compiling...')

    root.unmount()
  })

  test('renders title when provided', async () => {
    const terminal = createMockTerminal()
    const root = createRoot(terminal)

    const items: TaskItem[] = [
      { id: '1', label: 'Task 1', status: 'pending' },
    ]

    root.render(<TaskList items={items} title="My Tasks" />)
    await new Promise((r) => setTimeout(r, 50))

    const output = terminal.getPlainOutput()
    expect(output).toContain('My Tasks')

    root.unmount()
  })

  test('renders summary when showSummary=true', async () => {
    const terminal = createMockTerminal()
    const root = createRoot(terminal)

    const items: TaskItem[] = [
      { id: '1', label: 'Task 1', status: 'success' },
      { id: '2', label: 'Task 2', status: 'success' },
      { id: '3', label: 'Task 3', status: 'error' },
      { id: '4', label: 'Task 4', status: 'pending' },
    ]

    root.render(<TaskList items={items} showSummary />)
    await new Promise((r) => setTimeout(r, 50))

    const output = terminal.getPlainOutput()
    // Should show completed/total (3/4)
    expect(output).toContain('3/4')
    // Should show error count
    expect(output).toContain('1 error')

    root.unmount()
  })

  test('renders summary with elapsed time', async () => {
    const terminal = createMockTerminal()
    const root = createRoot(terminal)

    const items: TaskItem[] = [
      { id: '1', label: 'Task 1', status: 'success' },
    ]

    root.render(<TaskList items={items} showSummary elapsed={1500} />)
    await new Promise((r) => setTimeout(r, 50))

    const output = terminal.getPlainOutput()
    // Should show formatted elapsed time
    expect(output).toContain('1.5s')

    root.unmount()
  })

  test('updates when items change', async () => {
    const terminal = createMockTerminal()
    const root = createRoot(terminal)

    const items1: TaskItem[] = [
      { id: '1', label: 'Task 1', status: 'pending' },
    ]

    root.render(<TaskList items={items1} />)
    await new Promise((r) => setTimeout(r, 50))

    let output = terminal.getPlainOutput()
    expect(output).toContain('○') // Pending
    expect(output).toContain('Task 1')

    // Update to success
    const items2: TaskItem[] = [
      { id: '1', label: 'Task 1', status: 'success' },
    ]

    root.render(<TaskList items={items2} />)
    await new Promise((r) => setTimeout(r, 50))

    output = terminal.getPlainOutput()
    expect(output).toContain('✓') // Success

    root.unmount()
  })
})
