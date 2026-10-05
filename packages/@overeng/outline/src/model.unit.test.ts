import { describe, expect, it } from '@effect/vitest'
import { Schema } from 'effect'

import {
  activeSectionId,
  fixedPitchOffsets,
  resolveOutline,
  type MeasuredOutlineEntry,
} from './model.ts'

const Coordinate = Schema.Int.check(Schema.isBetween({ minimum: -10000, maximum: 10000 }))
const Tops = Schema.Array(Coordinate)
const measured = (tops: readonly number[]): readonly MeasuredOutlineEntry[] =>
  tops.toSorted((a, b) => a - b).map((top, index) => ({ id: String(index), top }))

describe('activeSectionId', () => {
  it.prop(
    'selects the last passed destination, or the first before any destination',
    [Tops, Coordinate],
    ([tops, edge]) => {
      const items = measured(tops)
      const expected = items.findLast((item) => item.top <= edge) ?? items[0]
      return activeSectionId({ items: items, readingEdge: edge }) === expected?.id
    },
  )
  it.prop(
    'never moves backwards as the reading edge advances',
    [Tops, Coordinate, Coordinate],
    ([tops, a, b]) => {
      const items = measured(tops)
      if (items.length === 0) return activeSectionId({ items: items, readingEdge: a }) === undefined
      const before = Number(activeSectionId({ items: items, readingEdge: Math.min(a, b) }))
      const after = Number(activeSectionId({ items: items, readingEdge: Math.max(a, b) }))
      return before <= after && before >= 0 && after < items.length
    },
  )
  it.prop(
    'is invariant under coordinate translation',
    [Tops, Coordinate, Coordinate],
    ([tops, edge, shift]) => {
      const items = measured(tops)
      return (
        activeSectionId({ items: items, readingEdge: edge }) ===
        activeSectionId({
          items: items.map((item) => ({ id: item.id, top: item.top + shift })),
          readingEdge: edge + shift,
        })
      )
    },
  )
  it.prop(
    'chooses the final destination at bottom independent of edge',
    [Tops, Coordinate],
    ([tops, edge]) => {
      const items = measured(tops)
      return (
        activeSectionId({ items: items, readingEdge: edge, atBottom: true }) === items.at(-1)?.id
      )
    },
  )
  it.prop(
    'uses the first destination before the start and last after the end',
    [Tops],
    ([tops]) => {
      const items = measured(tops)
      return (
        activeSectionId({ items: items, readingEdge: (items[0]?.top ?? 0) - 1 }) === items[0]?.id &&
        activeSectionId({ items: items, readingEdge: (items.at(-1)?.top ?? 0) + 1 }) ===
          items.at(-1)?.id
      )
    },
  )
  it('chooses the last document-ordered destination tied at the reading edge', () => {
    expect(
      activeSectionId({
        items: [
          { id: 'a', top: 10 },
          { id: 'b', top: 10 },
          { id: 'c', top: 20 },
        ],
        readingEdge: 10,
      }),
    ).toBe('b')
  })
})

describe('resolveOutline', () => {
  it('deduplicates nested equivalent titles and IDs while preserving gap-free siblings', () => {
    const result = resolveOutline({
      candidates: [
        { id: 'a', label: 'Title', rawDepth: 2, top: -10 },
        { id: 'heading', label: '  TITLE ', rawDepth: 4, top: 0 },
        { id: 'b', label: 'Child', rawDepth: 8, top: 20 },
        { id: 'c', label: 'Sibling', rawDepth: 6, top: 50 },
        { id: 'a', label: 'Repeated ID', rawDepth: 1, top: 75 },
        { id: 'd', label: 'Root', rawDepth: 1, top: 150 },
      ],
      documentHeight: 100,
    })
    expect(result.map(({ id, depth, position }) => ({ id, depth, position }))).toEqual([
      { id: 'a', depth: 0, position: 0 },
      { id: 'b', depth: 1, position: 0.2 },
      { id: 'c', depth: 1, position: 0.5 },
      { id: 'd', depth: 0, position: 1 },
    ])
  })
  it.prop('keeps hierarchy and proportional positions bounded', [Tops], ([depths]) => {
    const result = resolveOutline({
      candidates: depths.map((rawDepth, index) => ({
        id: String(index),
        label: String(index),
        rawDepth,
        top: rawDepth,
      })),
      documentHeight: 100,
    })
    return result.every(
      (entry, index) =>
        entry.depth >= 0 &&
        entry.depth <= index &&
        entry.position >= 0 &&
        entry.position <= 1 &&
        (index === 0 || entry.depth <= result[index - 1]!.depth + 1),
    )
  })
})

describe('fixedPitchOffsets', () => {
  it('preserves ordinary pitch, compresses long outlines, and never overlaps ticks', () => {
    expect(fixedPitchOffsets({ count: 0 })).toEqual([])
    expect(fixedPitchOffsets({ count: 1 })).toEqual([0])
    expect(fixedPitchOffsets({ count: 3 })).toEqual([0, 14, 28])
    expect(fixedPitchOffsets({ count: 23 }).at(-1)).toBe(308)
    expect(fixedPitchOffsets({ count: 155 }).at(-1)).toBe(308)
    expect(fixedPitchOffsets({ count: 156 }).at(-1)).toBe(310)
    expect(fixedPitchOffsets({ count: 3, maxTrackHeight: 10 })).toEqual([0, 5, 10])
  })
})
