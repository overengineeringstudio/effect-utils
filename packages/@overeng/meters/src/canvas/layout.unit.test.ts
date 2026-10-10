import { describe, expect, it } from '@effect/vitest'

import { fitText, layoutBlockText, layoutStrip } from './layout.ts'

/** Deterministic monospace metric: 6 CSS px per character. */
const measure = (text: string): number => text.length * 6

describe('responsive strip layout', () => {
  it('keeps nominal widths when the slot is wider, and never grows past them', () => {
    const layout = layoutStrip({
      widths: [150, 150, 150],
      heightPx: 32,
      gapPx: 2,
      dpr: 1.5,
      availableWidthPx: 1200,
    })
    expect(layout.rects.map((rect) => rect.width)).toEqual([150, 150, 150])
    expect(layout.widthPx).toBe(454)
    expect(layout.backingWidth).toBe(681)
  })
  it('shrinks proportionally only when the slot is too small, keeping gaps and fractional DPR', () => {
    const layout = layoutStrip({
      widths: [150, 150, 150],
      heightPx: 32,
      gapPx: 2,
      dpr: 1.25,
      availableWidthPx: 304,
    })
    expect(layout.rects.map((rect) => rect.width)).toEqual([100, 100, 100])
    expect(layout.rects.map((rect) => rect.x)).toEqual([0, 102, 204])
    expect(layout.widthPx).toBe(304)
    expect(layout.backingWidth).toBe(380)
    expect(layout.backingHeight).toBe(40)
  })
})

describe('block header text', () => {
  const overlaps = (options: {
    readonly label: { readonly x: number; readonly width: number } | undefined
    readonly value: { readonly x: number; readonly width: number } | undefined
  }): boolean =>
    options.label !== undefined &&
    options.value !== undefined &&
    options.label.x + options.label.width > options.value.x

  it('never overlaps label and value at any narrow width, and stays inside the block', () => {
    for (let width = 20; width <= 160; width++) {
      for (const [label, value] of [
        ['Frame rate', '59.5 fps'],
        ['JS heap (approximate)', '149.1 MiB'],
        ['Long frames', '285.1 ms'],
      ] as const) {
        const rect = { x: 10, y: 0, width, height: 32 }
        const header = layoutBlockText({ rect, label, value, measure })
        expect(overlaps(header)).toBe(false)
        for (const run of [header.label, header.value]) {
          if (run === undefined) continue
          expect(run.x).toBeGreaterThanOrEqual(rect.x)
          expect(run.x + run.width).toBeLessThanOrEqual(rect.x + rect.width)
          expect(measure(run.text)).toBe(run.width)
        }
      }
    }
  })
  it('reserves the value first, then prefers the full label, a short label, an ellipsis, or nothing', () => {
    const rect = (width: number) => ({ x: 0, y: 0, width, height: 32 })
    const base = { label: 'JS heap (approximate)', shortLabel: 'Heap', value: '149.1 MiB', measure }
    expect(layoutBlockText({ ...base, rect: rect(200) }).label?.text).toBe('JS heap (approximate)')
    expect(layoutBlockText({ ...base, rect: rect(100) })).toEqual({
      value: { text: '149.1 MiB', x: 42, width: 54 },
      label: { text: 'Heap', x: 4, width: 24 },
    })
    const ellipsized = layoutBlockText({ ...base, shortLabel: undefined, rect: rect(110) }).label
    expect(ellipsized?.text).toBe('JS hea…')
    expect(layoutBlockText({ ...base, rect: rect(70) })).toEqual({
      value: { text: '149.1 MiB', x: 12, width: 54 },
      label: undefined,
    })
  })
  it('fits by measuring and ellipsizing, never by reporting an over-wide run', () => {
    expect(fitText({ text: 'Frame rate', maxWidth: 60, measure })).toEqual({
      text: 'Frame rate',
      x: 0,
      width: 60,
    })
    expect(fitText({ text: 'Frame rate', maxWidth: 40, measure })).toEqual({
      text: 'Frame…',
      x: 0,
      width: 36,
    })
    expect(fitText({ text: 'Frame rate', maxWidth: 6, measure })).toBeUndefined()
  })
})
