import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import * as React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Devbar, type DevbarPanel, type DevbarSegment } from './Devbar.tsx'

const panels: readonly DevbarPanel[] = [
  {
    id: 'performance',
    label: 'Performance',
    badge: 'Live',
    render: () => <button type="button">Inspect frame</button>,
  },
  { id: 'logs', label: 'Logs', render: () => <p>Recent entries</p> },
]

const segments: readonly DevbarSegment[] = [
  { id: 'sync', render: () => <output aria-label="Sync status">Connected</output> },
]

/** Host harness owning the controlled selection, recording every proposal. */
const Host = ({
  initial,
  onProposal,
}: {
  initial?: string | undefined
  onProposal?: (id: string | undefined) => void
}): React.ReactNode => {
  const [openPanel, setOpenPanel] = React.useState<string | undefined>(initial)
  return (
    <Devbar
      panels={panels}
      segments={segments}
      openPanel={openPanel}
      onOpenPanelChange={(id) => {
        onProposal?.(id)
        setOpenPanel(id)
      }}
    />
  )
}

const bar = () => screen.getByRole('group', { name: 'Developer bar' })
const toggle = () => screen.getByRole('button', { name: 'Toggle developer tools' })
const pointerClick = (element: HTMLElement) => fireEvent.click(element, { detail: 1 })

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Devbar controlled state', () => {
  it('renders exactly the host-selected panel and proposes changes without applying them', () => {
    const onOpenPanelChange = vi.fn()
    const { rerender } = render(
      <Devbar panels={panels} openPanel={undefined} onOpenPanelChange={onOpenPanelChange} />,
    )
    pointerClick(screen.getByRole('button', { name: 'Logs' }))
    expect(onOpenPanelChange).toHaveBeenCalledExactlyOnceWith('logs')
    // The host rejected the proposal: nothing opens.
    expect(screen.queryByRole('region')).toBeNull()
    expect(screen.getByRole('button', { name: 'Logs' }).getAttribute('aria-expanded')).toBe('false')

    rerender(<Devbar panels={panels} openPanel="logs" onOpenPanelChange={onOpenPanelChange} />)
    expect(screen.getByRole('region', { name: 'Logs' }).textContent).toContain('Recent entries')
    expect(screen.queryByText('Inspect frame')).toBeNull()
  })

  it('renders an unknown panel ID closed without proposing a correction', () => {
    const onOpenPanelChange = vi.fn()
    render(<Devbar panels={panels} openPanel="removed" onOpenPanelChange={onOpenPanelChange} />)
    expect(screen.queryByRole('region')).toBeNull()
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(onOpenPanelChange).not.toHaveBeenCalled()
  })

  it('never touches browser storage', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem')
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const { unmount } = render(<Host />)
    pointerClick(screen.getByRole('button', { name: 'Logs' }))
    pointerClick(toggle())
    unmount()
    render(<Host />)
    expect(screen.queryByRole('region')).toBeNull()
    expect(getItem).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
  })

  it('toggles between closed and the last valid panel, falling back to the first', () => {
    const proposals: Array<string | undefined> = []
    render(<Host onProposal={(id) => proposals.push(id)} />)
    pointerClick(toggle())
    expect(screen.getByRole('region', { name: 'Performance' })).toBeTruthy()
    pointerClick(screen.getByRole('button', { name: 'Logs' }))
    pointerClick(toggle())
    expect(screen.queryByRole('region')).toBeNull()
    pointerClick(toggle())
    expect(screen.getByRole('region', { name: 'Logs' })).toBeTruthy()
    expect(proposals).toEqual(['performance', 'logs', undefined, 'logs'])
  })

  it('disables the toggle when there are no panels to propose', () => {
    const onOpenPanelChange = vi.fn()
    render(<Devbar panels={[]} openPanel={undefined} onOpenPanelChange={onOpenPanelChange} />)
    expect(toggle().hasAttribute('disabled')).toBe(true)
    fireEvent.keyDown(window, { code: 'Backquote', key: '`', ctrlKey: true })
    expect(onOpenPanelChange).not.toHaveBeenCalled()
  })
})

describe('Devbar interaction', () => {
  it('routes Ctrl/Meta+Backquote and unconsumed Escape through the same callback', () => {
    const proposals: Array<string | undefined> = []
    render(<Host onProposal={(id) => proposals.push(id)} />)
    fireEvent.keyDown(window, { code: 'Backquote', key: '`', ctrlKey: true })
    expect(screen.getByRole('region', { name: 'Performance' })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('region')).toBeNull()
    fireEvent.keyDown(window, { code: 'Backquote', key: '`', metaKey: true })
    expect(screen.getByRole('region', { name: 'Performance' })).toBeTruthy()
    // Modified shortcuts are not the toggle.
    fireEvent.keyDown(window, { code: 'Backquote', key: '`', ctrlKey: true, shiftKey: true })
    expect(screen.getByRole('region', { name: 'Performance' })).toBeTruthy()
    expect(proposals).toEqual(['performance', undefined, 'performance'])
  })

  it('respects defaultPrevented for Escape and the shortcut', () => {
    const onProposal = vi.fn()
    render(<Host initial="logs" onProposal={onProposal} />)
    const consumed = (init: KeyboardEventInit) => {
      const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true })
      event.preventDefault()
      window.dispatchEvent(event)
    }
    consumed({ key: 'Escape' })
    consumed({ code: 'Backquote', key: '`', ctrlKey: true })
    expect(onProposal).not.toHaveBeenCalled()
    expect(screen.getByRole('region', { name: 'Logs' })).toBeTruthy()
  })

  it('removes its keyboard listener on unmount', () => {
    const onOpenPanelChange = vi.fn()
    const { unmount } = render(
      <Devbar panels={panels} openPanel="logs" onOpenPanelChange={onOpenPanelChange} />,
    )
    unmount()
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.keyDown(window, { code: 'Backquote', key: '`', ctrlKey: true })
    expect(onOpenPanelChange).not.toHaveBeenCalled()
  })

  it('exposes expanded state and panel relationships, and a close action', () => {
    render(<Host initial="performance" />)
    const region = screen.getByRole('region', { name: 'Performance' })
    const tab = screen.getByRole('button', { name: 'Performance Live' })
    expect(region.id).not.toBe('')
    expect(tab.getAttribute('aria-expanded')).toBe('true')
    expect(tab.getAttribute('aria-controls')).toBe(region.id)
    expect(toggle().getAttribute('aria-controls')).toBe(region.id)
    expect(screen.getByRole('button', { name: 'Logs' }).getAttribute('aria-controls')).toBeNull()
    pointerClick(screen.getByRole('button', { name: 'Close Performance panel' }))
    expect(screen.queryByRole('region')).toBeNull()
  })

  it('restores focus to the initiating control when a keyboard close removes focused content', () => {
    render(<Host />)
    const tab = screen.getByRole('button', { name: 'Performance Live' })
    fireEvent.click(tab, { detail: 0 })
    const inner = screen.getByRole('button', { name: 'Inspect frame' })
    act(() => inner.focus())
    fireEvent.keyDown(inner, { key: 'Escape' })
    expect(screen.queryByRole('region')).toBeNull()
    expect(document.activeElement).toBe(tab)
  })

  it('does not steal focus on pointer close', () => {
    render(<Host />)
    pointerClick(screen.getByRole('button', { name: 'Performance Live' }))
    act(() => screen.getByRole('button', { name: 'Inspect frame' }).focus())
    pointerClick(screen.getByRole('button', { name: 'Close Performance panel' }))
    expect(screen.queryByRole('region')).toBeNull()
    expect(document.activeElement).not.toBe(
      screen.getByRole('button', { name: 'Performance Live' }),
    )
  })
})

describe('Devbar composition and geometry', () => {
  it('orders the row as controls, strip, then host segments', () => {
    render(
      <Devbar
        panels={panels}
        strip={<span>strip placeholder</span>}
        segments={segments}
        openPanel={undefined}
        onOpenPanelChange={() => {}}
      />,
    )
    const [controls, strip, hostSegments] = Array.from(bar().children)
    expect(controls?.contains(toggle())).toBe(true)
    expect(strip?.textContent).toBe('strip placeholder')
    expect(hostSegments?.contains(screen.getByRole('status', { name: 'Sync status' }))).toBe(true)
  })

  it('mounts the panel above the same row node instead of re-creating or moving it', () => {
    render(<Host />)
    const row = bar()
    const root = screen.getByRole('complementary', { name: 'Developer tools' })
    expect(root.lastElementChild).toBe(row)
    pointerClick(screen.getByRole('button', { name: 'Logs' }))
    const region = screen.getByRole('region', { name: 'Logs' })
    expect(bar()).toBe(row)
    expect(root.lastElementChild).toBe(row)
    expect(region.nextElementSibling).toBe(row)
    expect(row.className).toBe(bar().className)
  })

  it('starts no frame callbacks, timers, or observers without a strip', () => {
    const rafCalls = vi.fn(() => 0)
    const intervalCalls = vi.fn(() => 0)
    const observerCalls = vi.fn()
    class CountingObserver {
      constructor() {
        observerCalls()
      }
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return []
      }
    }
    vi.stubGlobal('requestAnimationFrame', rafCalls)
    vi.stubGlobal('setInterval', intervalCalls)
    vi.stubGlobal('PerformanceObserver', CountingObserver)
    vi.stubGlobal('ResizeObserver', CountingObserver)
    vi.stubGlobal('IntersectionObserver', CountingObserver)
    vi.stubGlobal('MutationObserver', CountingObserver)
    const windowRaf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0)
    const windowInterval = vi.spyOn(window, 'setInterval').mockImplementation(() => {
      throw new Error('The strip-free shell must not start an interval')
    })

    const { unmount } = render(
      <React.StrictMode>
        <Host />
      </React.StrictMode>,
    )
    pointerClick(screen.getByRole('button', { name: 'Logs' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    unmount()

    expect(rafCalls).not.toHaveBeenCalled()
    expect(windowRaf).not.toHaveBeenCalled()
    expect(intervalCalls).not.toHaveBeenCalled()
    expect(windowInterval).not.toHaveBeenCalled()
    expect(observerCalls).not.toHaveBeenCalled()
  })
})
