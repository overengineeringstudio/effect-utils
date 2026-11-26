import { describe, expect, it } from 'vitest'

import { cropRect, drawAnnotations, type AnnotationTheme } from './annotations.ts'

const theme: AnnotationTheme = {
  ink: '#c8a24a',
  badgeFill: '#e2c071',
  badgeInk: '#2a1a08',
  captionInk: '#2a1a08',
  captionHalo: '#fff8ec',
  highlight: '#ffd75e',
  fontFamily: 'Figtree, sans-serif',
}
const viewport = { width: 390, height: 844 }
const box = { x: 40, y: 600, width: 48, height: 64 }

describe('drawAnnotations', () => {
  const draw = (seed: string) =>
    drawAnnotations({
      seed,
      theme,
      viewport,
      placed: [
        { box, annotation: { kind: 'caption', target: '#t', side: 'top', text: 'Trumpf <neu>' } },
        { box, annotation: { kind: 'arrow', target: '#t', from: { dx: 120, dy: -80 } } },
        { box, annotation: { kind: 'ring', n: 1, target: '#t', caption: 'Eins' } },
        { box, annotation: { kind: 'mark', target: '#t', style: 'underline' } },
      ],
    })

  it('is deterministic per seed and hand-drawn differently across seeds', () => {
    expect(draw('2026-11-22-x:phone')).toBe(draw('2026-11-22-x:phone'))
    expect(draw('2026-11-22-x:phone')).not.toBe(draw('2026-11-22-y:phone'))
  })

  it('draws marks and rings beneath arrows and captions, with escaped text', () => {
    const svg = draw('seed')
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('pointer-events:none')
    const ring = svg.indexOf('<circle')
    const caption = svg.indexOf('<text x')
    expect(ring).toBeGreaterThan(0)
    expect(svg.lastIndexOf('Trumpf &lt;neu&gt;')).toBeGreaterThan(ring)
    expect(caption).toBeGreaterThan(ring)
    expect(svg).toContain('>1</text>')
  })

  it('keeps ring captions out of the image (they are published as text)', () => {
    expect(draw('seed')).not.toContain('Eins')
  })
})

describe('cropRect', () => {
  it('clamps to the viewport and snaps outwards to whole pixels', () => {
    expect(cropRect({ base: { x: -4.5, y: 10.2, width: 400, height: 20.1 }, viewport })).toEqual({
      x: 0,
      y: 10,
      width: 390,
      height: 21,
    })
  })
})
