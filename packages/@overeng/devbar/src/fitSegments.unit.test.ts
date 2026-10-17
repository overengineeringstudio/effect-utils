import { describe, expect, it } from 'vitest'

import { fitSegments } from './fitSegments.ts'

const segments = [
  { id: 'version', width: 50, priority: 1 },
  { id: 'websocket', width: 50, priority: 4 },
  { id: 'http', width: 50, priority: 3 },
  { id: 'subscriptions', width: 50, priority: 2 },
  { id: 'message-rate', width: 50, priority: 0 },
]

describe('fitSegments', () => {
  it('hides ascending priorities while keeping visible items in declaration order', () => {
    expect(fitSegments({ segments, available: 180, overflowWidth: 20 })).toEqual([
      'websocket',
      'http',
      'subscriptions',
    ])
    expect(fitSegments({ segments, available: 130, overflowWidth: 20 })).toEqual([
      'websocket',
      'http',
    ])
    expect(fitSegments({ segments, available: 80, overflowWidth: 20 })).toEqual(['websocket'])
  })

  it('defaults priority to zero and hides later-declared ties first', () => {
    expect(
      fitSegments({
        segments: [
          { id: 'first', width: 50 },
          { id: 'second', width: 50, priority: 0 },
          { id: 'third', width: 50 },
        ],
        available: 120,
        overflowWidth: 20,
      }),
    ).toEqual(['first', 'second'])
  })

  it('reserves overflow width and its gap as soon as any item is hidden', () => {
    expect(
      fitSegments({
        segments: segments.slice(0, 3),
        available: 129,
        overflowWidth: 30,
        gap: 10,
      }),
    ).toEqual(['websocket'])
    expect(
      fitSegments({
        segments: segments.slice(0, 3),
        available: 150,
        overflowWidth: 30,
        gap: 10,
      }),
    ).toEqual(['websocket', 'http'])
  })

  it('returns all items at the exact all-fit boundary without reserving overflow', () => {
    expect(fitSegments({ segments, available: 290, overflowWidth: 40, gap: 10 })).toEqual(
      segments.map((segment) => segment.id),
    )
  })

  it('keeps the highest-priority item at its exact overflow-inclusive boundary', () => {
    expect(fitSegments({ segments, available: 80, overflowWidth: 20, gap: 10 })).toEqual([
      'websocket',
    ])
    expect(fitSegments({ segments, available: 79, overflowWidth: 20, gap: 10 })).toEqual([])
  })

  it('returns only overflow when no segment fits, even when overflow exceeds the budget', () => {
    expect(fitSegments({ segments, available: 20, overflowWidth: 20 })).toEqual([])
    expect(fitSegments({ segments, available: 0, overflowWidth: 20 })).toEqual([])
  })

  it('does not promote a lower-priority narrow item past a higher-priority wide item', () => {
    expect(
      fitSegments({
        segments: [
          { id: 'narrow', width: 10, priority: 0 },
          { id: 'wide', width: 200, priority: 1 },
        ],
        available: 100,
        overflowWidth: 20,
      }),
    ).toEqual([])
  })

  it('handles an empty composition and negative priorities', () => {
    expect(fitSegments({ segments: [], available: 0, overflowWidth: 20 })).toEqual([])
    expect(
      fitSegments({
        segments: [
          { id: 'negative', width: 50, priority: -1 },
          { id: 'default', width: 50 },
        ],
        available: 70,
        overflowWidth: 20,
      }),
    ).toEqual(['default'])
  })
})
