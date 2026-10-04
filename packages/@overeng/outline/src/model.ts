/** Stable semantic destinations in document order; callers own extraction and measurement. */
export interface OutlineEntry {
  readonly id: string
  readonly label: string
  readonly depth: number
  readonly description?: string
  readonly href?: string
  readonly position?: number
}
export type OutlineHrefEntry = OutlineEntry & { readonly href: string }
export interface OutlineCandidate {
  readonly id: string
  readonly label: string
  readonly rawDepth: number
  readonly top: number
  readonly description?: string
  readonly href?: string
}
export type ResolvedOutlineEntry = OutlineEntry & { readonly top: number; readonly position: number }
export interface MeasuredOutlineEntry { readonly id: string; readonly top: number }

/** Drops repeated IDs and immediately nested equivalent titles, then derives gap-free depth. */
export const resolveOutline = (candidates: readonly OutlineCandidate[], documentHeight: number): readonly ResolvedOutlineEntry[] => {
  const kept: OutlineCandidate[] = []
  const seen = new Set<string>()
  const normalize = (label: string): string => label.replace(/\s+/g, ' ').trim().toLowerCase()
  for (const candidate of candidates) {
    if (candidate.id === '' || candidate.label === '' || seen.has(candidate.id)) continue
    const previous = kept.at(-1)
    if (previous !== undefined && candidate.rawDepth > previous.rawDepth && normalize(previous.label) === normalize(candidate.label)) continue
    seen.add(candidate.id)
    kept.push(candidate)
  }
  const depths: number[] = []
  return kept.map(({rawDepth, ...entry}) => {
    while (depths.length > 0 && depths[depths.length - 1]! >= rawDepth) depths.pop()
    const depth = depths.length
    depths.push(rawDepth)
    return {...entry, depth, position: documentHeight > 0 ? Math.min(1, Math.max(0, entry.top / documentHeight)) : 0}
  })
}

/** Measurements must have nondecreasing tops in document order and use readingEdge's coordinates. */
export const activeSectionId = (items: readonly MeasuredOutlineEntry[], readingEdge: number, atBottom: boolean = false): string | undefined => {
  if (atBottom) return items.at(-1)?.id
  let active = items[0]?.id
  for (const item of items) {
    if (item.top > readingEdge) break
    active = item.id
  }
  return active
}

/** Long rails compress only to the two-pixel tick height; the expanded list owns overflow. */
export const fixedPitchOffsets = (count: number, maxTrackHeight: number = 308, pitch: number = 14): readonly number[] => {
  const effectivePitch = count < 2 ? 0 : Math.max(2, Math.min(pitch, maxTrackHeight / (count - 1)))
  return Array.from({length: count}, (_, index) => index * effectivePitch)
}

/** A caller-owned pane or document adapter. Measure only resolved outline IDs. */
export interface OutlineScrollAdapter {
  readonly measure: () => readonly MeasuredOutlineEntry[]
  readonly read: () => { readonly readingEdge: number; readonly atBottom: boolean }
  readonly navigate: (id: string, behavior: 'smooth' | 'auto') => void
  readonly subscribe: (notify: () => void) => () => void
}

/** Suitable for useSyncExternalStore's getSnapshot; subscription lifetime remains caller-owned. */
export const getActiveSection = (adapter: Pick<OutlineScrollAdapter, 'measure' | 'read'>): string | undefined => {
  const {readingEdge, atBottom} = adapter.read()
  return activeSectionId(adapter.measure(), readingEdge, atBottom)
}
