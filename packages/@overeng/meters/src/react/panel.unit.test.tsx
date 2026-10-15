// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from '@effect/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import * as React from 'react'

import { darkMeterTheme, lightMeterTheme, numberBlock } from '../canvas/index.ts'
import { makeSeries, type NumberValue } from '../series/index.ts'
import { MetersPanel, type MetersPanelProps } from './index.tsx'

afterEach(cleanup)

const blocks = ['Work', 'Pending'].map((label) => {
  const id = label.toLowerCase()
  const series = makeSeries<NumberValue>({ id, label, unit: 'count', capacity: 8 })
  return numberBlock({ id, series })
})
const renderDetail: MetersPanelProps['renderDetail'] = (block) => (
  <section aria-label={`${block.label} details`}>{block.id}</section>
)

describe('MetersPanel', () => {
  it('lists every meter, proposes selection, and renders only the host-selected detail', () => {
    const selections: { readonly id: string }[] = []
    const props: MetersPanelProps = {
      blocks,
      theme: lightMeterTheme,
      selected: 'work',
      onSelect: (selection) => selections.push(selection),
      renderDetail,
    }
    const view = render(<MetersPanel {...props} />)
    const list = within(screen.getByRole('group', { name: 'Meter selection' }))
    const work = list.getByRole('button', { name: 'Work' })
    const pending = list.getByRole('button', { name: 'Pending' })
    expect(list.getAllByRole('button').length).toBe(2)
    expect(work.getAttribute('aria-pressed')).toBe('true')
    expect(pending.getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('region', { name: 'Work details' }).textContent).toBe('work')
    expect(screen.queryByRole('region', { name: 'Pending details' })).toBeNull()
    expect(document.getElementById(work.getAttribute('aria-controls')!)?.textContent).toBe('work')

    fireEvent.click(pending)
    // Rejecting a proposal must leave the controlled detail and selection unchanged.
    expect(selections).toEqual([{ id: 'pending' }])
    expect(work.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('region', { name: 'Work details' })).toBeDefined()

    view.rerender(<MetersPanel {...props} selected="pending" />)
    expect(pending.getAttribute('aria-pressed')).toBe('true')
    expect(work.getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByRole('region', { name: 'Work details' })).toBeNull()
    expect(screen.getByRole('region', { name: 'Pending details' }).textContent).toBe('pending')
    expect(document.getElementById(pending.getAttribute('aria-controls')!)?.textContent).toBe(
      'pending',
    )
    // Native button keyboard activation arrives as a zero-detail click.
    fireEvent.click(work, { detail: 0 })
    expect(selections).toEqual([{ id: 'pending' }, { id: 'work' }])
  })

  it('leaves unknown selection reconciliation to the host and handles an empty list', () => {
    const selections: { readonly id: string }[] = []
    const props: MetersPanelProps = {
      blocks,
      theme: lightMeterTheme,
      selected: 'removed',
      onSelect: (selection) => selections.push(selection),
      renderDetail,
    }
    const view = render(<MetersPanel {...props} />)
    expect(screen.getByText('Select a meter to view its details.')).toBeDefined()
    expect(
      screen
        .getAllByRole('button')
        .every((button) => button.getAttribute('aria-pressed') === 'false'),
    ).toBe(true)
    expect(screen.queryByRole('region')).toBeNull()
    expect(selections).toEqual([])

    view.rerender(<MetersPanel {...props} blocks={[]} selected={undefined} />)
    expect(screen.getByText('No meters configured.')).toBeDefined()
    expect(screen.queryByRole('button')).toBeNull()
    expect(selections).toEqual([])
  })

  for (const theme of [lightMeterTheme, darkMeterTheme]) {
    it(`uses the supplied ${theme === lightMeterTheme ? 'light' : 'dark'} theme`, () => {
      const view = render(
        <MetersPanel
          blocks={blocks}
          theme={theme}
          selected="work"
          onSelect={() => {}}
          renderDetail={renderDetail}
        />,
      )
      const panel = view.container.firstElementChild
      expect(panel).toBeInstanceOf(HTMLElement)
      const expected = document.createElement('div')
      expected.style.color = theme.foreground
      expected.style.background = theme.background
      expected.style.outlineColor = theme.focus
      expect(panel?.getAttribute('style')).toContain(`color: ${expected.style.color}`)
      expect(panel?.getAttribute('style')).toContain(`background: ${expected.style.background}`)
      expect(screen.getByRole('button', { name: 'Work' }).style.outlineColor).toBe(
        expected.style.outlineColor,
      )
    })
  }
})
