import { describe, expect, it, vi } from 'vitest'

import { make, type RingCompletion, type RingSpan } from './SpanRing.ts'

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
  it('delivers content-free completions synchronously beyond ring capacity and removes hooks', () => {
    vi.useFakeTimers()
    try {
      const ring = make({ capacity: 1 })
      const completions: RingCompletion[] = []
      ring.push(span('old history'))
      const unsubscribe = ring.subscribeCompletions({
        onComplete: (completion) => {
          completions.push(completion)
        },
      })
      ring.push({ ...span('content'), attributes: { secret: 'not delivered' } })
      ring.push({ ...span('failure'), status: 'error', durationMs: 3 })
      expect(completions).toEqual([
        { atMs: 1, durationMs: 1, status: 'ok' },
        { atMs: 3, durationMs: 3, status: 'error' },
      ])
      expect(ring.getSnapshot().spans).toHaveLength(1)
      unsubscribe()
      ring.push(span('after release'))
      ring.updateVitals({ cls: 1 })
      expect(completions).toHaveLength(2)
      vi.runAllTimers()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports subscriber faults without skipping other completion listeners', () => {
    vi.useFakeTimers()
    try {
      const ring = make()
      const failure = new Error('listener failure')
      ring.subscribeCompletions({
        onComplete: () => {
          throw failure
        },
      })
      const completions: RingCompletion[] = []
      ring.subscribeCompletions({
        onComplete: (completion) => {
          completions.push(completion)
        },
      })
      expect(() => ring.push(span('action'))).toThrow(failure)
      expect(completions).toEqual([{ atMs: 1, durationMs: 1, status: 'ok' }])
      vi.runAllTimers()
    } finally {
      vi.useRealTimers()
    }
  })

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
