import { describe, expect, it } from '@effect/vitest'

import { measureTestText as measure } from './_test-canvas.ts'
import { fitText, layoutBlockText, layoutStrip } from './layout.ts'

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
      for (const [label, value, compactValue, numberValue] of [
        ['Frame rate', '59.5 fps', '60fps', '60'],
        ['JS heap (approximate)', '149.1 MiB', '149MiB', '149'],
        ['Long frames', '285.1 ms', '285ms', '285'],
      ] as const) {
        const rect = { x: 10, y: 0, width, height: 32 }
        const header = layoutBlockText({ rect, label, value, compactValue, numberValue, measure })
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
  it('degrades through full label, short label, full value, compact value, number, and ellipsis', () => {
    const rect = (width: number) => ({ x: 0, y: 0, width, height: 32 })
    const base = {
      label: 'JS heap (approx)',
      shortLabel: 'Heap',
      value: '95.3 MiB',
      compactValue: '95MiB',
      numberValue: '95',
      measure,
    }
    for (const [width, label, value] of [
      [200, 'JS heap (approx)', '95.3 MiB'],
      [150, 'Heap', '95.3 MiB'],
      [70, undefined, '95.3 MiB'],
      [50, undefined, '95MiB'],
      [20, undefined, '95'],
      [14, undefined, '…'],
      [13, undefined, undefined],
    ] as const) {
      const header = layoutBlockText({ ...base, rect: rect(width) })
      expect(header.label?.text).toBe(label)
      expect(header.value?.text).toBe(value)
      expect(overlaps(header)).toBe(false)
    }
    expect(
      layoutBlockText({ ...base, shortLabel: undefined, rect: rect(150) }).label,
    ).toBeUndefined()
  })
  it('keeps the full value before compacting, without restoring labels for compact values', () => {
    const base = {
      label: 'Frame rate',
      shortLabel: 'FPS',
      value: '59.9 fps',
      compactValue: '60fps',
      numberValue: '60',
      measure,
    }
    expect(layoutBlockText({ ...base, rect: { x: 10, y: 0, width: 70, height: 32 } })).toEqual({
      value: { text: '59.9 fps', x: 28, width: 48 },
      label: undefined,
    })
    expect(layoutBlockText({ ...base, rect: { x: 10, y: 0, width: 50, height: 32 } })).toEqual({
      value: { text: '60fps', x: 26, width: 30 },
      label: undefined,
    })
  })
  it('ellipsizes only after even the number cannot fit', () => {
    expect(
      layoutBlockText({
        rect: { x: 0, y: 0, width: 26, height: 32 },
        label: 'Duration',
        value: '123456.7 ms',
        compactValue: '123457ms',
        numberValue: '123457',
        measure,
      }),
    ).toEqual({
      value: { text: '12…', x: 4, width: 18 },
      label: undefined,
    })
  })
  it('can show an intact label when no value text is provided', () => {
    expect(
      layoutBlockText({
        rect: { x: 0, y: 0, width: 50, height: 32 },
        label: 'Heap',
        value: '',
        measure,
      }),
    ).toEqual({
      value: undefined,
      label: { text: 'Heap', x: 4, width: 24 },
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
