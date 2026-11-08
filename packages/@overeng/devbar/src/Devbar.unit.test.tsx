import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import * as React from 'react'
import { createPortal } from 'react-dom'
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
  suppliedPanels = panels,
}: {
  initial?: string | undefined
  onProposal?: (id: string | undefined) => void
  suppliedPanels?: readonly DevbarPanel[]
}): React.ReactNode => {
  const [openPanel, setOpenPanel] = React.useState<string | undefined>(initial)
  return (
    <Devbar
      panels={suppliedPanels}
      segments={segments}
      openPanel={openPanel}
      onOpenPanelChange={(id) => {
        onProposal?.(id)
        setOpenPanel(id)
      }}
    />
  )
}

const bar = () => screen.getByRole('toolbar', { name: 'Developer bar' })
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
    fireEvent.keyDown(toggle(), { key: 'Escape' })
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

  it('closes on Escape inside the panel and returns focus to the toggle', () => {
    render(<Host />)
    fireEvent.click(screen.getByRole('button', { name: 'Performance Live' }), { detail: 0 })
    const inner = screen.getByRole('button', { name: 'Inspect frame' })
    act(() => inner.focus())
    fireEvent.keyDown(inner, { key: 'Escape' })
    expect(screen.queryByRole('region')).toBeNull()
    expect(document.activeElement).toBe(toggle())
  })

  it('closes on Escape inside the bar row and focuses the toggle', () => {
    render(<Host initial="performance" />)
    const rowControl = screen.getByRole('button', { name: 'Logs' })
    act(() => rowControl.focus())
    fireEvent.keyDown(rowControl, { key: 'Escape' })
    expect(screen.queryByRole('region')).toBeNull()
    expect(document.activeElement).toBe(toggle())
  })

  it('returns focus to the toggle on pointer close when focus is inside the panel', () => {
    render(<Host />)
    pointerClick(screen.getByRole('button', { name: 'Performance Live' }))
    act(() => screen.getByRole('button', { name: 'Inspect frame' }).focus())
    pointerClick(screen.getByRole('button', { name: 'Close Performance panel' }))
    expect(screen.queryByRole('region')).toBeNull()
    expect(document.activeElement).toBe(toggle())
  })

  it('does not close on Escape from an element outside the bar', () => {
    const onProposal = vi.fn()
    render(
      <>
        <textarea aria-label="Host input" />
        <Host initial="performance" onProposal={onProposal} />
      </>,
    )
    const outside = screen.getByRole('textbox', { name: 'Host input' })
    act(() => outside.focus())
    fireEvent.keyDown(outside, { key: 'Escape' })
    expect(screen.getByRole('region', { name: 'Performance' })).toBeTruthy()
    expect(onProposal).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(outside)
  })

  it('does not close when a nested popover prevents Escape', () => {
    const onProposal = vi.fn()
    render(
      <Host
        initial="popover"
        onProposal={onProposal}
        suppliedPanels={[
          {
            id: 'popover',
            label: 'Popover panel',
            render: () => (
              <div role="dialog" aria-label="Nested popover">
                <button
                  type="button"
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') event.preventDefault()
                  }}
                >
                  Popover action
                </button>
              </div>
            ),
          },
        ]}
      />,
    )
    const nested = screen.getByRole('button', { name: 'Popover action' })
    act(() => nested.focus())
    fireEvent.keyDown(nested, { key: 'Escape' })
    expect(screen.getByRole('region', { name: 'Popover panel' })).toBeTruthy()
    expect(onProposal).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(nested)
  })

  it('does not close on Escape from portalled panel content outside the root', () => {
    const onProposal = vi.fn()
    render(
      <Host
        initial="portal"
        onProposal={onProposal}
        suppliedPanels={[
          {
            id: 'portal',
            label: 'Portal panel',
            render: () =>
              createPortal(<button type="button">Portalled action</button>, document.body),
          },
        ]}
      />,
    )
    const portalled = screen.getByRole('button', { name: 'Portalled action' })
    act(() => portalled.focus())
    fireEvent.keyDown(portalled, { key: 'Escape' })
    expect(screen.getByRole('region', { name: 'Portal panel' })).toBeTruthy()
    expect(onProposal).not.toHaveBeenCalled()
  })

  it('returns focus to the toggle when the host closes focused panel content', () => {
    const { rerender } = render(
      <Devbar panels={panels} openPanel="performance" onOpenPanelChange={() => {}} />,
    )
    act(() => screen.getByRole('button', { name: 'Inspect frame' }).focus())
    rerender(<Devbar panels={panels} openPanel={undefined} onOpenPanelChange={() => {}} />)
    expect(screen.queryByRole('region')).toBeNull()
    expect(document.activeElement).toBe(toggle())
  })

  it('does not steal outside focus when the host closes the panel', () => {
    const { rerender } = render(
      <>
        <textarea aria-label="Host input" />
        <Devbar panels={panels} openPanel="performance" onOpenPanelChange={() => {}} />
      </>,
    )
    const outside = screen.getByRole('textbox', { name: 'Host input' })
    act(() => outside.focus())
    rerender(
      <>
        <textarea aria-label="Host input" />
        <Devbar panels={panels} openPanel={undefined} onOpenPanelChange={() => {}} />
      </>,
    )
    expect(document.activeElement).toBe(outside)
  })

  it.each([false, true])(
    'does not restore stale focus after a rejected close (switchPanel=%s)',
    (switchPanel) => {
      const onOpenPanelChange = vi.fn()
      const view = ({ openPanel }: { openPanel: string | undefined }) => (
        <>
          <textarea aria-label="Host input" />
          <Devbar panels={panels} openPanel={openPanel} onOpenPanelChange={onOpenPanelChange} />
        </>
      )
      const { rerender } = render(view({ openPanel: 'performance' }))
      const inner = screen.getByRole('button', { name: 'Inspect frame' })
      act(() => inner.focus())
      fireEvent.keyDown(inner, { key: 'Escape' })
      expect(onOpenPanelChange).toHaveBeenCalledExactlyOnceWith(undefined)
      expect(screen.getByRole('region', { name: 'Performance' })).toBeDefined()
      expect(document.activeElement).toBe(inner)
      if (switchPanel === true) {
        pointerClick(screen.getByRole('button', { name: 'Logs' }))
        rerender(view({ openPanel: 'logs' }))
      }
      const outside = screen.getByRole('textbox', { name: 'Host input' })
      act(() => outside.focus())
      rerender(view({ openPanel: undefined }))
      expect(screen.queryByRole('region')).toBeNull()
      expect(document.activeElement).toBe(outside)
    },
  )
})

describe('row focus', () => {
  const buttons: readonly DevbarSegment[] = ['alpha', 'beta', 'gamma'].map((id) => ({
    id,
    render: () => <button type="button">{id}</button>,
  }))
  const Row = ({ shown = buttons }: { shown?: readonly DevbarSegment[] }): React.ReactNode => (
    <Devbar
      panels={panels}
      panelControls="none"
      openPanel={undefined}
      onOpenPanelChange={() => {}}
      segments={shown}
    />
  )
  // Give the row room so no segment overflows; the shell measures with real layout otherwise.
  const roomy = () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000)
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ width: 40, height: 20 }),
    )
  }
  // Measurement reveals segments after mount; the row re-evaluates on that DOM change.
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  const tabStops = () =>
    Array.from(bar().querySelectorAll<HTMLElement>('button')).filter(
      (button) =>
        button.closest('[inert], [popover]') === null && button.getAttribute('tabindex') !== '-1',
    )

  it('is one Tab stop, with arrows, Home and End moving between items', async () => {
    roomy()
    render(<Row />)
    await settle()
    expect(tabStops().map((button) => button.textContent)).toEqual(['alpha'])
    const alpha = screen.getByRole('button', { name: 'alpha' })
    act(() => alpha.focus())
    fireEvent.keyDown(alpha, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'beta' }))
    expect(tabStops().map((button) => button.textContent)).toEqual(['beta'])
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'gamma' }))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(alpha)
    fireEvent.keyDown(alpha, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'gamma' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(document.activeElement).toBe(alpha)
  })

  it('keeps focus on the same item across re-renders with new render functions', async () => {
    roomy()
    const { rerender } = render(<Row />)
    await settle()
    const beta = screen.getByRole('button', { name: 'beta' })
    act(() => beta.focus())
    rerender(
      <Row
        shown={buttons.map((segment) => ({
          ...segment,
          render: () => <button type="button">{segment.id}</button>,
        }))}
      />,
    )
    await settle()
    expect(document.activeElement).toBe(beta)
    expect(tabStops().map((button) => button.textContent)).toEqual(['beta'])
  })

  it('moves focus to a remaining item, not the body, when the focused item disappears', async () => {
    roomy()
    const { rerender } = render(<Row />)
    await settle()
    act(() => screen.getByRole('button', { name: 'gamma' }).focus())
    rerender(<Row shown={buttons.slice(0, 2)} />)
    await settle()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'beta' }))
    expect(tabStops().map((button) => button.textContent)).toEqual(['beta'])
  })

  it('never gives the Tab stop to an item that cannot take focus', async () => {
    roomy()
    render(
      <Row
        shown={[
          {
            id: 'hidden',
            render: () => (
              <button type="button" hidden>
                hidden
              </button>
            ),
          },
          { id: 'secret', render: () => <input type="hidden" value="secret" /> },
          ...buttons,
        ]}
      />,
    )
    await settle()
    expect(screen.getByRole('button', { name: 'alpha' }).getAttribute('tabindex')).toBe('0')
    expect(bar().querySelectorAll('[tabindex="0"]')).toHaveLength(1)
  })

  it('never gives the Tab stop to a CSS-hidden item, including one hidden later', async () => {
    roomy()
    // Neither test DOM implements checkVisibility; this stands in for the browser's style check.
    Object.defineProperty(HTMLElement.prototype, 'checkVisibility', {
      configurable: true,
      value(this: HTMLElement) {
        return this.closest('[style*="display: none"]') === null
      },
    })
    try {
      render(
        <Row
          shown={[
            {
              id: 'collapsed',
              render: () => (
                <span style={{ display: 'none' }}>
                  <button type="button">collapsed</button>
                </span>
              ),
            },
            ...buttons,
          ]}
        />,
      )
      await settle()
      expect(
        screen.getByRole('button', { name: 'alpha', hidden: true }).getAttribute('tabindex'),
      ).toBe('0')
      expect(bar().querySelectorAll('[tabindex="0"]')).toHaveLength(1)
      // A host hiding the Tab stop through its own style moves the stop, without a shell render.
      const alpha = screen.getByRole('button', { name: 'alpha' })
      act(() => alpha.setAttribute('style', 'display: none'))
      await settle()
      expect(screen.getByRole('button', { name: 'beta' }).getAttribute('tabindex')).toBe('0')
      expect(alpha.getAttribute('tabindex')).toBe('-1')
      expect(bar().querySelectorAll('[tabindex="0"]')).toHaveLength(1)
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'checkVisibility')
    }
  })

  it('includes contenteditable hosts as items, keeping their own arrow keys', async () => {
    roomy()
    render(
      <Row
        shown={[
          ...buttons,
          {
            id: 'note',
            render: () => (
              <div contentEditable suppressContentEditableWarning aria-label="note">
                text
              </div>
            ),
          },
        ]}
      />,
    )
    await settle()
    const note = screen.getByLabelText('note')
    expect(note.getAttribute('tabindex')).toBe('-1')
    const alpha = screen.getByRole('button', { name: 'alpha' })
    act(() => alpha.focus())
    fireEvent.keyDown(alpha, { key: 'End' })
    expect(document.activeElement).toBe(note)
    fireEvent.keyDown(note, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(note)
  })

  it('takes an item whose wrapper becomes aria-hidden out of focus and the Tab sequence', async () => {
    roomy()
    render(<Row />)
    await settle()
    const gamma = screen.getByRole('button', { name: 'gamma' })
    act(() => gamma.focus())
    act(() => gamma.parentElement!.setAttribute('aria-hidden', 'true'))
    await settle()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'beta' }))
    expect(gamma.getAttribute('tabindex')).toBe('-1')
    expect(tabStops()).toEqual([screen.getByRole('button', { name: 'beta' })])
  })

  it('keeps one Tab stop and recovers focus in a row of only shell controls', async () => {
    const Shell = ({ shown }: { shown: readonly DevbarPanel[] }): React.ReactNode => (
      <Devbar panels={shown} openPanel={undefined} onOpenPanelChange={() => {}} />
    )
    const { rerender } = render(<Shell shown={panels.slice(0, 1)} />)
    rerender(<Shell shown={panels} />)
    expect(bar().querySelectorAll('[tabindex="0"]')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Logs' }).getAttribute('tabindex')).toBe('-1')
    act(() => screen.getByRole('button', { name: 'Logs' }).focus())
    rerender(<Shell shown={panels.slice(0, 1)} />)
    await settle()
    expect(document.activeElement).not.toBe(document.body)
    expect(bar().contains(document.activeElement)).toBe(true)
    expect(bar().querySelectorAll('[tabindex="0"]')).toHaveLength(1)
  })
})

describe('host-driven panels', () => {
  it('omits an empty strip slot when the strip is content-sized', () => {
    const { rerender } = render(
      <Devbar
        panels={panels}
        panelControls="none"
        openPanel={undefined}
        onOpenPanelChange={() => {}}
        stripSizing="content"
        segments={segments}
      />,
    )
    expect(bar().children).toHaveLength(1)
    rerender(
      <Devbar
        panels={panels}
        panelControls="none"
        openPanel={undefined}
        onOpenPanelChange={() => {}}
        segments={segments}
      />,
    )
    expect(bar().children).toHaveLength(2)
  })

  const Driven = (): React.ReactNode => {
    const [openPanel, setOpenPanel] = React.useState<string | undefined>(undefined)
    return (
      <Devbar
        panels={panels}
        panelControls="none"
        panelElementId="drawer"
        openPanel={openPanel}
        onOpenPanelChange={setOpenPanel}
        strip={
          <button
            type="button"
            aria-expanded={openPanel === 'logs'}
            onClick={() => setOpenPanel((open) => (open === 'logs' ? undefined : 'logs'))}
          >
            Meter
          </button>
        }
        trailing={<button type="button">Version</button>}
      />
    )
  }

  it('renders no panel buttons, only host triggers and the trailing item', () => {
    render(<Driven />)
    expect(screen.queryByRole('button', { name: 'Toggle developer tools' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Logs' })).toBeNull()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getByRole('button', { name: 'Version' })).toBeTruthy()
  })

  it('opens from a host trigger onto tabs at a stable panel id', () => {
    render(<Driven />)
    pointerClick(screen.getByRole('button', { name: 'Meter' }))
    expect(screen.getByRole('tab', { name: 'Logs' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tabpanel', { name: 'Logs' }).id).toBe('drawer')
    expect(screen.getByRole('tab', { name: 'Logs' }).getAttribute('aria-controls')).toBe('drawer')
    pointerClick(screen.getByRole('button', { name: 'Meter' }))
    expect(screen.queryByRole('tabpanel')).toBeNull()
  })

  it('moves between tabs by keyboard and returns focus to the opener on close', () => {
    render(<Driven />)
    const meter = screen.getByRole('button', { name: 'Meter' })
    act(() => meter.focus())
    pointerClick(meter)
    const tab = screen.getByRole('tab', { name: 'Logs' })
    act(() => tab.focus())
    fireEvent.keyDown(tab, { key: 'ArrowRight' })
    const wrapped = screen.getByRole('tab', { name: /Performance/ })
    expect(document.activeElement).toBe(wrapped)
    expect(screen.getByRole('tabpanel', { name: 'Performance' })).toBeTruthy()
    expect(meter.getAttribute('aria-expanded')).toBe('false')
    fireEvent.keyDown(wrapped, { key: 'Escape' })
    expect(screen.queryByRole('tabpanel')).toBeNull()
    expect(document.activeElement).toBe(meter)
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

  it('starts no frame callbacks, timers, or observers without a strip or segments', () => {
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
        <Devbar panels={panels} openPanel="logs" onOpenPanelChange={() => {}} />
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
