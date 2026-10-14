import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import * as React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BuildIdentitySegment } from './BuildIdentitySegment.tsx'
import { Devbar } from './Devbar.tsx'

const now = 1_800_000_000
const identity = {
  rev: 'a7647bb123456789',
  dirty: false,
  commitTs: now - 3 * 3600,
  buildTs: now - 720,
  displayVersion: '0.1.0+a7647bb — committed 3 hours ago',
  machineVersion: '0.1.0+a7647bb',
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('BuildIdentitySegment', () => {
  it('makes the same details available through hover and keyboard focus, with Escape dismissal', () => {
    render(<BuildIdentitySegment identity={identity} now={now} />)
    const trigger = screen.getByRole('button', { name: 'Build identity: a7647bb · 3h' })
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.mouseEnter(trigger)
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip.textContent).toContain(identity.displayVersion)
    expect(tooltip.textContent).toContain(`machineVersion ${identity.machineVersion}`)
    expect(tooltip.textContent).toContain('deployed 12m ago')
    expect(trigger.getAttribute('aria-describedby')).toBe(tooltip.id)
    fireEvent.mouseLeave(trigger)
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.focus(trigger)
    expect(screen.getByRole('tooltip').textContent).toContain(identity.machineVersion)
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.blur(trigger)
    fireEvent.focus(trigger)
    expect(screen.getByRole('tooltip')).toBeDefined()
    fireEvent.blur(trigger)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('anchors the first disclosure hover above the actual button before any focus', () => {
    render(
      <BuildIdentitySegment
        identity={identity}
        now={now}
        disclosure={{ label: 'Changelog', render: () => <p>Release notes</p> }}
      />,
    )
    const trigger = screen.getByRole('button', { name: /show Changelog/ })
    const bounds = vi
      .spyOn(trigger, 'getBoundingClientRect')
      .mockReturnValue(DOMRect.fromRect({ x: 100, y: 250, width: 180, height: 24 }))
    expect(document.activeElement).not.toBe(trigger)
    fireEvent.mouseEnter(trigger)
    const tooltip = screen.getByRole('tooltip')
    expect(bounds).toHaveBeenCalledTimes(1)
    expect(tooltip.getAttribute('style')).toContain(`${window.innerHeight - 250}px`)
    expect(tooltip.getAttribute('style')).toContain(`${Math.max(8, window.innerWidth - 280)}px`)
    expect(trigger.getAttribute('aria-describedby')).toBe(tooltip.id)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('dismisses hovered details with focus outside the trigger before closing the open panel', () => {
    const onOpenPanelChange = vi.fn()
    const { unmount } = render(
      <React.StrictMode>
        <Devbar
          panels={[{ id: 'logs', label: 'Logs', render: () => <button>Inspect logs</button> }]}
          segments={[
            { id: 'build', render: () => <BuildIdentitySegment identity={identity} now={now} /> },
          ]}
          openPanel="logs"
          onOpenPanelChange={onOpenPanelChange}
        />
      </React.StrictMode>,
    )
    const outside = screen.getByRole('button', { name: 'Inspect logs' })
    outside.focus()
    const trigger = screen.getByRole('button', { name: 'Build identity: a7647bb · 3h' })
    fireEvent.mouseEnter(trigger)
    expect(screen.getByRole('tooltip')).toBeDefined()
    fireEvent.keyDown(outside, { key: 'Tab' })
    expect(screen.getByRole('tooltip')).toBeDefined()
    fireEvent.keyDown(outside, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(document.activeElement).toBe(outside)
    expect(screen.getByRole('region', { name: 'Logs' })).toBeDefined()
    expect(onOpenPanelChange).not.toHaveBeenCalled()
    fireEvent.keyDown(outside, { key: 'Escape' })
    expect(onOpenPanelChange).toHaveBeenCalledExactlyOnceWith(undefined)
    fireEvent.mouseLeave(trigger)
    fireEvent.mouseEnter(trigger)
    expect(screen.getByRole('tooltip')).toBeDefined()
    unmount()
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    document.dispatchEvent(escape)
    expect(escape.defaultPrevented).toBe(false)
  })

  it('does not invent commit or deploy ages when their timestamps are absent', () => {
    render(
      <BuildIdentitySegment
        identity={{ ...identity, dirty: true, commitTs: undefined, buildTs: undefined }}
        now={now}
      />,
    )
    const trigger = screen.getByRole('button', { name: 'Build identity: a7647bb* · n/a' })
    fireEvent.focus(trigger)
    expect(screen.getByRole('tooltip').textContent).not.toContain('deployed')
  })

  it('runs no clock for deterministic fixed-time rendering', () => {
    vi.useFakeTimers()
    const baseline = vi.getTimerCount()
    const { unmount } = render(<BuildIdentitySegment identity={identity} now={now} />)
    expect(vi.getTimerCount()).toBe(baseline)
    unmount()
    expect(vi.getTimerCount()).toBe(baseline)
  })

  it('ticks once per minute only while mounted, with one clock for multiple StrictMode segments', () => {
    vi.useFakeTimers()
    vi.setSystemTime(now * 1000)
    const baseline = vi.getTimerCount()
    const liveIdentity = { ...identity, commitTs: now - 60 }
    const { rerender, unmount } = render(
      <React.StrictMode>
        <BuildIdentitySegment identity={liveIdentity} />
        <BuildIdentitySegment identity={liveIdentity} />
      </React.StrictMode>,
    )
    expect(vi.getTimerCount()).toBe(baseline + 1)
    expect(screen.getAllByRole('button', { name: 'Build identity: a7647bb · 1m' })).toHaveLength(2)
    act(() => vi.advanceTimersByTime(59_000))
    expect(screen.getAllByRole('button', { name: 'Build identity: a7647bb · 1m' })).toHaveLength(2)
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getAllByRole('button', { name: 'Build identity: a7647bb · 2m' })).toHaveLength(2)
    rerender(
      <React.StrictMode>
        <BuildIdentitySegment identity={liveIdentity} />
      </React.StrictMode>,
    )
    expect(vi.getTimerCount()).toBe(baseline + 1)
    unmount()
    expect(vi.getTimerCount()).toBe(baseline)
    act(() => vi.advanceTimersByTime(60_000))
    expect(vi.getTimerCount()).toBe(baseline)
    render(<BuildIdentitySegment identity={liveIdentity} />)
    expect(screen.getByRole('button', { name: 'Build identity: a7647bb · 3m' })).toBeDefined()
    expect(vi.getTimerCount()).toBe(baseline + 1)
  })
})
