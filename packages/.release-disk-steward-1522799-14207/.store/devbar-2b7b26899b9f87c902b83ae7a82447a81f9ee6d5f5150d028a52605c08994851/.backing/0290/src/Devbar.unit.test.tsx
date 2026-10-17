import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import * as React from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Devbar, type DevbarPanel } from './Devbar.tsx'

const panels: readonly DevbarPanel[] = [
  { id: 'fps', label: 'Performance', badge: 'Live', render: () => <p>Frame timing</p> },
  { id: 'logs', label: 'Logs', render: () => <p>Recent entries</p> },
]

beforeEach(() => window.localStorage.clear())
afterEach(cleanup)

describe('Devbar panel navigation', () => {
  it('starts collapsed, opens only the selected panel, and toggles it closed', () => {
    render(<Devbar panels={panels} persist={false} />)
    const performance = screen.getByRole('button', { name: 'Performance Live' })
    const logs = screen.getByRole('button', { name: 'Logs' })
    expect(screen.queryByText('Frame timing')).toBeNull()
    fireEvent.click(performance)
    expect(screen.getByRole('region', { name: 'Performance' }).textContent).toBe('Frame timing')
    expect(performance.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(logs)
    expect(screen.getByRole('region', { name: 'Logs' }).textContent).toBe('Recent entries')
    expect(screen.queryByText('Frame timing')).toBeNull()
    fireEvent.click(logs)
    expect(screen.queryByRole('region', { name: 'Logs' })).toBeNull()
  })

  it('restores saved panels by scoped storage key and remembers a collapsed selection', () => {
    const { unmount } = render(<Devbar panels={panels} storageKey="a" />)
    fireEvent.click(screen.getByRole('button', { name: 'Logs' }))
    expect(window.localStorage.getItem('a')).toBe('logs')
    unmount()
    render(<Devbar panels={panels} storageKey="a" />)
    expect(screen.getByText('Recent entries')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Toggle developer tools/ }))
    expect(window.localStorage.getItem('a')).toBe('')
    fireEvent.click(screen.getByRole('button', { name: /Toggle developer tools/ }))
    expect(screen.getByText('Recent entries')).toBeTruthy()
    expect(window.localStorage.getItem('a')).toBe('logs')
  })

  it('ignores stale stored panels and disables persistence when requested', () => {
    window.localStorage.setItem('a', 'missing')
    const { unmount } = render(<Devbar panels={panels} storageKey="a" />)
    expect(screen.queryByRole('region')).toBeNull()
    unmount()
    render(<Devbar panels={panels} persist={false} storageKey="a" />)
    fireEvent.click(screen.getByRole('button', { name: 'Logs' }))
    expect(window.localStorage.getItem('a')).toBe('missing')
  })

  it('prioritizes valid deep links over storage and opens a newly requested deep link', () => {
    window.localStorage.setItem('a', 'logs')
    const { rerender } = render(<Devbar panels={panels} storageKey="a" deepLinkPanel="fps" />)
    expect(screen.getByText('Frame timing')).toBeTruthy()
    rerender(<Devbar panels={panels} storageKey="a" deepLinkPanel="logs" />)
    expect(screen.getByText('Recent entries')).toBeTruthy()
    expect(window.localStorage.getItem('a')).toBe('logs')
  })

  it('keeps an operator-selected panel when the host rerenders without changing its deep link', () => {
    const { rerender } = render(<Devbar panels={panels} persist={false} deepLinkPanel="fps" />)
    fireEvent.click(screen.getByRole('button', { name: 'Logs' }))
    rerender(<Devbar panels={[...panels]} persist={false} deepLinkPanel="fps" />)
    expect(screen.getByRole('region', { name: 'Logs' }).textContent).toBe('Recent entries')
  })

  it('opens with Ctrl+Backquote, closes with Escape, and reopens the last panel', () => {
    render(<Devbar panels={panels} persist={false} />)
    fireEvent.keyDown(window, { code: 'Backquote', key: '`', ctrlKey: true })
    expect(screen.getByText('Frame timing')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Logs' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByText('Recent entries')).toBeNull()
    fireEvent.keyDown(window, { code: 'Backquote', key: '`', metaKey: true })
    expect(screen.getByText('Recent entries')).toBeTruthy()
    fireEvent.keyDown(window, { code: 'Backquote', key: '`', ctrlKey: true, shiftKey: true })
    expect(screen.getByText('Recent entries')).toBeTruthy()
  })
})
