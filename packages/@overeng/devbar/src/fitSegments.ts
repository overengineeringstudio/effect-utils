/** Natural widths include each segment's content, but not the gap between segments. */
export interface SegmentWidth {
  readonly id: string
  readonly width: number
  readonly priority?: number | undefined
}

/** Natural segment widths plus the space budget the visible segments and overflow control must fit in. */
export interface FitSegmentsOptions {
  readonly segments: readonly SegmentWidth[]
  readonly available: number
  readonly overflowWidth: number
  readonly gap?: number | undefined
}

/** Hide low priorities first; preserve declaration order among the surviving IDs. */
export const fitSegments = ({
  segments,
  available,
  overflowWidth,
  gap = 0,
}: FitSegmentsOptions): readonly string[] => {
  let width = segments.reduce((total, segment) => total + segment.width, 0)
  if (width + Math.max(0, segments.length - 1) * gap <= available) {
    return segments.map((segment) => segment.id)
  }

  const hideOrder = segments
    .map((segment, index) => ({ ...segment, index }))
    .toSorted(
      (left, right) => (left.priority ?? 0) - (right.priority ?? 0) || right.index - left.index,
    )
  const hidden = new Set<string>()
  for (const segment of hideOrder) {
    hidden.add(segment.id)
    width -= segment.width
    const remaining = segments.length - hidden.size
    // With overflow present there is one gap per remaining segment.
    if (width + remaining * gap + overflowWidth <= available) break
  }
  return segments.filter((segment) => hidden.has(segment.id) === false).map((segment) => segment.id)
}
