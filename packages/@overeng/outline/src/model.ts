/** Stable semantic destinations in document order; callers own extraction and measurement. */
export interface OutlineEntry {
  readonly id: string
  readonly label: string
  readonly depth: number
  readonly description?: string
  readonly href?: string
  readonly position?: number
}
/** Outline destination with a native browser navigation target. */
export type OutlineHrefEntry = OutlineEntry & { readonly href: string }
/** Raw caller-discovered destination before hierarchy normalization. */
export interface OutlineCandidate {
  readonly id: string
  readonly label: string
  readonly rawDepth: number
  readonly top: number
  readonly description?: string
  readonly href?: string
}
/** Normalized destination with a measured top and bounded document position. */
export type ResolvedOutlineEntry = OutlineEntry & {
  readonly top: number
  readonly position: number
}
/** Coordinates used by scroll-derived active-section selection. */
export interface MeasuredOutlineEntry {
  readonly id: string
  readonly top: number
}

const normalize = (label: string): string => label.replace(/\s+/g, ' ').trim().toLowerCase()

/** Drops repeated IDs and immediately nested equivalent titles, then derives gap-free depth. */
export const resolveOutline = ({
  candidates,
  documentHeight,
}: {
  readonly candidates: readonly OutlineCandidate[]
  readonly documentHeight: number
}): readonly ResolvedOutlineEntry[] => {
  const kept: OutlineCandidate[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (candidate.id === '' || candidate.label === '' || seen.has(candidate.id) === true) continue
    const previous = kept.at(-1)
    if (
      previous !== undefined &&
      candidate.rawDepth > previous.rawDepth &&
      normalize(previous.label) === normalize(candidate.label)
    )
      continue
    seen.add(candidate.id)
    kept.push(candidate)
  }
  const depths: number[] = []
  return kept.map((candidate) => {
    while (depths.length > 0 && depths[depths.length - 1]! >= candidate.rawDepth) depths.pop()
    const depth = depths.length
    depths.push(candidate.rawDepth)
    const entry: { -readonly [TKey in keyof ResolvedOutlineEntry]: ResolvedOutlineEntry[TKey] } = {
      id: candidate.id,
      label: candidate.label,
      top: candidate.top,
      depth,
      position: documentHeight > 0 ? Math.min(1, Math.max(0, candidate.top / documentHeight)) : 0,
    }
    if (candidate.description !== undefined) entry.description = candidate.description
    if (candidate.href !== undefined) entry.href = candidate.href
    return entry
  })
}

/** Measurements must have nondecreasing tops in document order and use readingEdge's coordinates. */
export const activeSectionId = ({
  items,
  readingEdge,
  atBottom = false,
}: {
  readonly items: readonly MeasuredOutlineEntry[]
  readonly readingEdge: number
  readonly atBottom?: boolean
}): string | undefined => {
  if (atBottom === true) return items.at(-1)?.id
  let active = items[0]?.id
  for (const item of items) {
    if (item.top > readingEdge) break
    active = item.id
  }
  return active
}

/** Long rails compress only to the two-pixel tick height; the expanded list owns overflow. */
export const fixedPitchOffsets = ({
  count,
  maxTrackHeight = 308,
  pitch = 14,
}: {
  readonly count: number
  readonly maxTrackHeight?: number
  readonly pitch?: number
}): readonly number[] => {
  const effectivePitch = count < 2 ? 0 : Math.max(2, Math.min(pitch, maxTrackHeight / (count - 1)))
  return Array.from({ length: count }, (_, index) => index * effectivePitch)
}

/** A caller-owned pane or document adapter. Measure only resolved outline IDs. */
export interface OutlineScrollAdapter {
  readonly measure: () => readonly MeasuredOutlineEntry[]
  readonly read: () => { readonly readingEdge: number; readonly atBottom: boolean }
  readonly navigate: (id: string, behavior: 'smooth' | 'auto') => void
  readonly subscribe: (notify: () => void) => () => void
}

/** Suitable for useSyncExternalStore's getSnapshot; subscription lifetime remains caller-owned. */
export const getActiveSection = (
  adapter: Pick<OutlineScrollAdapter, 'measure' | 'read'>,
): string | undefined => {
  const { readingEdge, atBottom } = adapter.read()
  return activeSectionId({ items: adapter.measure(), readingEdge, atBottom })
}
