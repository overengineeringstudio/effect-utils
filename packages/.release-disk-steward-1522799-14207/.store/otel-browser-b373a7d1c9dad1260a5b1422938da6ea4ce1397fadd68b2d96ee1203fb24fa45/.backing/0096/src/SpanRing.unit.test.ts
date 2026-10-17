import { describe, expect, it } from 'vitest'

import { make, type RingSpan } from './SpanRing.ts'

const span = (name: string): RingSpan => ({
  name,
  label: name,
  traceId: '0af7651916cd43dd8448eb211c80319c',
  spanId: 'b7ad6b7169203331',
  parentSpanId: undefined,
  startMs: 0,
  durationMs: 1,
  status: 'ok',
  sampled: false,
  attributes: {},
})

describe('SpanRing', () => {
  it('retains the newest spans in chronological order across wraparound', () => {
    const ring = make({ capacity: 2 })
    ring.push(span('first'))
    ring.push(span('second'))
    const oldSnapshot = ring.getSnapshot()
    ring.push(span('third'))
    ring.push(span('fourth'))
    expect(ring.getSnapshot().spans.map(({ name }) => name)).toEqual(['third', 'fourth'])
    expect(oldSnapshot.spans.map(({ name }) => name)).toEqual(['first', 'second'])
  })

  it('keeps snapshots stable between updates and preserves vitals across span pushes', () => {
    const ring = make({ capacity: 1 })
    const initial = ring.getSnapshot()
    expect(ring.getSnapshot()).toBe(initial)
    ring.updateVitals({ inpMs: 120, cls: 0.2 })
    const updated = ring.getSnapshot()
    expect(updated).not.toBe(initial)
    expect(ring.getSnapshot()).toBe(updated)
    ring.push(span('action'))
    expect(ring.getSnapshot().vitals).toMatchObject({ inpMs: 120, cls: 0.2 })
    expect(initial.vitals).toMatchObject({ inpMs: undefined, cls: 0 })
  })
})
