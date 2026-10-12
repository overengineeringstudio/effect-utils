import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BuildIdentitySegment } from './BuildIdentitySegment.tsx'
import { Devbar } from './Devbar.tsx'
import { AnchoredDisclosure } from './disclosure.tsx'

const now = 1_800_000_000
const identity = {
  rev: 'a7647bb123456789',
  dirty: false,
  commitTs: now - 10800,
  buildTs: now - 720,
  displayVersion: '0.1.0+a7647bb',
  machineVersion: '0.1.0+a7647bb',
}

const nativePopoverDescriptors = {
  showPopover: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'showPopover'),
  hidePopover: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'hidePopover'),
}

// The unit DOM lacks the browser top layer. Model only its native open/close state;
// real nested light dismissal and keyboard defaults are covered by story plays.
beforeEach(() => {
  const open = new WeakSet<Element>()
  const matches = Element.prototype.matches
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (selector) {
    return selector === ':popover-open' ? open.has(this) : matches.call(this, selector)
  })
  Object.defineProperties(HTMLElement.prototype, {
    showPopover: {
      configurable: true,
      value: vi.fn(function (this: HTMLElement) {
        open.add(this)
      }),
    },
    hidePopover: {
      configurable: true,
      value: vi.fn(function (this: HTMLElement) {
        open.delete(this)
      }),
    },
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const name of ['showPopover', 'hidePopover'] as const) {
    const descriptor = nativePopoverDescriptors[name]
    if (descriptor === undefined) Reflect.deleteProperty(HTMLElement.prototype, name)
    else Object.defineProperty(HTMLElement.prototype, name, descriptor)
  }
})

describe('anchored disclosure', () => {
  it.each(['{Enter}', ' '])(
    'opens with %s, renders lazily, and notifies once per transition',
    async (key) => {
      const user = userEvent.setup()
      const renderContent = vi.fn(() => <p>Improved search filters</p>)
      const onOpenChange = vi.fn()
      const { rerender } = render(
        <BuildIdentitySegment
          identity={identity}
          now={now}
          disclosure={{ label: 'Changelog', hasUnseen: true, render: renderContent, onOpenChange }}
        />,
      )
      const trigger = screen.getByRole('button', { name: /show Changelog, unseen changes/ })
      expect(renderContent).not.toHaveBeenCalled()
      trigger.focus()
      await user.keyboard(key)
      const dialog = screen.getByRole('dialog', { name: 'Changelog' })
      expect(dialog.textContent).toContain('Improved search filters')
      expect(screen.queryByRole('tooltip')).toBeNull()
      expect(onOpenChange.mock.calls).toEqual([[true]])
      expect(trigger.querySelector('[data-devbar-unseen]')).not.toBeNull()
      rerender(
        <BuildIdentitySegment
          identity={identity}
          now={now}
          disclosure={{ label: 'Changelog', hasUnseen: false, render: renderContent, onOpenChange }}
        />,
      )
      expect(screen.getByRole('dialog', { name: 'Changelog' })).toBe(dialog)
      expect(trigger.querySelector('[data-devbar-unseen]')).toBeNull()
      expect(trigger.getAttribute('aria-label')).not.toContain('unseen changes')
      expect(onOpenChange.mock.calls).toEqual([[true]])
      fireEvent.keyDown(dialog, { key: 'Escape' })
      expect(trigger.getAttribute('aria-expanded')).toBe('false')
      expect(document.activeElement).toBe(trigger)
      expect(onOpenChange.mock.calls).toEqual([[true], [false]])
      const callsAfterClose = renderContent.mock.calls.length
      rerender(
        <BuildIdentitySegment
          identity={identity}
          now={now + 60}
          disclosure={{ label: 'Changelog', render: renderContent, onOpenChange }}
        />,
      )
      expect(renderContent).toHaveBeenCalledTimes(callsAfterClose)
      fireEvent.click(trigger)
      fireEvent.click(trigger)
      expect(onOpenChange.mock.calls).toEqual([[true], [false], [true], [false]])
    },
  )

  it('syncs native light dismissal without duplicate close notifications', () => {
    const onOpenChange = vi.fn()
    render(
      <AnchoredDisclosure
        label="Details"
        trigger="Details"
        triggerLabel="Show details"
        onOpenChange={onOpenChange}
      >
        <p>Host content</p>
      </AnchoredDisclosure>,
    )
    const trigger = screen.getByRole('button')
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog')
    act(() => {
      dialog.hidePopover()
      fireEvent(dialog, new Event('toggle'))
    })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent(dialog, new Event('toggle'))
    expect(onOpenChange.mock.calls).toEqual([[true], [false]])
  })

  it.each([
    { right: 20, expectedLeft: 8 },
    { right: 1600, expectedLeft: 716 },
  ])('clamps both viewport edges at $right', ({ right, expectedLeft }) => {
    vi.stubGlobal('innerWidth', 1024)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      return DOMRect.fromRect({
        x: this.tagName === 'BUTTON' ? right - 20 : 0,
        y: 700,
        width: this.tagName === 'BUTTON' ? 20 : 300,
        height: 30,
      })
    })
    render(
      <AnchoredDisclosure label="Details" trigger="Details" triggerLabel="Show details">
        <p>Host content</p>
      </AnchoredDisclosure>,
    )
    fireEvent.click(screen.getByRole('button'))
    const dialog = screen.getByRole('dialog')
    // StyleX dynamic properties carry the collision-adjusted CSS pixel value.
    expect(dialog.getAttribute('style')).toContain(`${expectedLeft}px`)
  })

  it.each([
    { top: 200, expectedHeight: 192, expectedAnchor: 120 },
    { top: 40, expectedHeight: 248, expectedAnchor: 64 },
    { top: 148, expectedHeight: 140, expectedAnchor: 172 },
  ])(
    'bounds an overflow-list disclosure in a short viewport at $top',
    ({ top, expectedHeight, expectedAnchor }) => {
      vi.stubGlobal('innerHeight', 320)
      vi.stubGlobal('innerWidth', 900)
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
        const isBuild = this.getAttribute('aria-label')?.includes('show Changelog') === true
        return DOMRect.fromRect({
          x: 600,
          y: isBuild === true ? top : 290,
          width:
            this.hasAttribute('data-devbar-segment-content') === true
              ? 1000
              : this.tagName === 'BUTTON'
                ? 160
                : 300,
          height: this.tagName === 'BUTTON' ? 24 : 500,
        })
      })
      render(
        <Devbar
          panels={[]}
          openPanel={undefined}
          onOpenPanelChange={() => {}}
          segments={[
            {
              id: 'build',
              render: () => (
                <BuildIdentitySegment
                  identity={identity}
                  now={now}
                  disclosure={{ label: 'Changelog', render: () => <p>Long release notes</p> }}
                />
              ),
            },
          ]}
        />,
      )
      fireEvent.click(screen.getByRole('button', { name: /more status items/ }))
      const overflow = screen.getByRole('dialog', { name: 'More status items' })
      fireEvent.click(within(overflow).getByRole('button', { name: /show Changelog/ }))
      const dialog = screen.getByRole('dialog', { name: 'Changelog' })
      expect(dialog.getAttribute('style')).toContain(`min(24rem, ${expectedHeight}px)`)
      expect(dialog.getAttribute('style')).toContain(`${expectedAnchor}px`)
      expect(dialog.getAttribute('style')).toContain('460px')
    },
  )

  it('does not mirror alerts on segments that remain visible', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      const segment = this.parentElement?.getAttribute('data-devbar-segment')
      return DOMRect.fromRect({
        width: segment === 'visible' ? 200 : segment === 'hidden' ? 400 : 40,
      })
    })
    render(
      <Devbar
        panels={[]}
        openPanel={undefined}
        onOpenPanelChange={() => {}}
        segments={[
          { id: 'visible', priority: 5, hasAlert: true, render: () => <span>Visible alert</span> },
          { id: 'hidden', priority: 0, hasAlert: false, render: () => <span>Hidden status</span> },
        ]}
      />,
    )
    const overflow = screen.getByRole('button', { name: '1 more status items: hidden' })
    expect(overflow.querySelector('[data-devbar-unseen]')).toBeNull()
  })

  it('closes a fitted-away trigger without focus theft and notifies teardown once', () => {
    const onOpenChange = vi.fn()
    const content = (
      <AnchoredDisclosure
        label="Details"
        trigger="Details"
        triggerLabel="Show details"
        onOpenChange={onOpenChange}
      >
        <p>Host content</p>
      </AnchoredDisclosure>
    )
    const { rerender, unmount } = render(<div inert={false}>{content}</div>)
    fireEvent.click(screen.getByRole('button'))
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    rerender(
      <div inert>
        <AnchoredDisclosure
          label="Details"
          trigger="Details"
          triggerLabel="Show details"
          onOpenChange={onOpenChange}
        >
          <p>Host content</p>
        </AnchoredDisclosure>
      </div>,
    )
    expect(onOpenChange.mock.calls).toEqual([[true], [false]])
    expect(document.activeElement).toBe(outside)
    unmount()
    expect(onOpenChange.mock.calls).toEqual([[true], [false]])
    outside.remove()
  })

  it('aggregates only hidden alerts and consumes dialog, tooltip, overflow, then panel Escape', () => {
    const onOpenPanelChange = vi.fn()
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      return DOMRect.fromRect({
        x: 100,
        y: 700,
        width: this.hasAttribute('data-devbar-segment-content') === true ? 400 : 40,
        height: 30,
      })
    })
    render(
      <Devbar
        panels={[{ id: 'logs', label: 'Logs', render: () => <p>Recent requests</p> }]}
        openPanel="logs"
        onOpenPanelChange={onOpenPanelChange}
        segments={[
          {
            id: 'build',
            hasAlert: true,
            render: () => (
              <BuildIdentitySegment
                identity={identity}
                now={now}
                disclosure={{
                  label: 'Changelog',
                  hasUnseen: true,
                  render: () => <button>Read release notes</button>,
                }}
              />
            ),
          },
        ]}
      />,
    )
    const overflow = screen.getByRole('button', {
      name: '1 more status items: build, including unseen changes',
    })
    expect(overflow.querySelector('[data-devbar-unseen]')).not.toBeNull()
    fireEvent.click(overflow)
    const overflowDialog = screen.getByRole('dialog', { name: 'More status items' })
    const build = within(overflowDialog).getByRole('button', { name: /show Changelog/ })
    fireEvent.click(build)
    const dialog = screen.getByRole('dialog', { name: 'Changelog' })
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(document.activeElement).toBe(build)
    expect(overflow.getAttribute('aria-expanded')).toBe('true')
    expect(onOpenPanelChange).not.toHaveBeenCalled()
    fireEvent.mouseEnter(build)
    expect(screen.getByRole('tooltip')).toBeDefined()
    fireEvent.keyDown(build, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(overflow.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(build, { key: 'Escape' })
    expect(overflow.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(overflow)
    expect(onOpenPanelChange).not.toHaveBeenCalled()
    fireEvent.keyDown(overflow, { key: 'Escape' })
    expect(onOpenPanelChange).toHaveBeenCalledExactlyOnceWith(undefined)
  })
})
