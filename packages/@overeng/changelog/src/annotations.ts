import type { Annotation } from './contract.ts'

/**
 * Hand-drawn annotation geometry. Pure and deterministic: the same seed, boxes and theme always
 * produce the same SVG bytes, so re-rendering an unchanged scene reproduces its pictures.
 */

/** A rectangle in CSS pixels, relative to the viewport. */
export interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Colours and type for one colour scheme. */
export interface AnnotationTheme {
  /** Ring, arrow and underline stroke. */
  readonly ink: string
  /** Number badge fill (e.g. a brass gradient's mid tone). */
  readonly badgeFill: string
  readonly badgeInk: string
  /** Burnt-in caption text and its halo. */
  readonly captionInk: string
  readonly captionHalo: string
  /** Translucent marker colour for `highlight`. */
  readonly highlight: string
  readonly fontFamily: string
}

/** One annotation with its resolved target box and display text. */
export interface PlacedAnnotation {
  readonly annotation: Annotation<string>
  readonly box: Box
}

type Point = readonly [number, number]

/** FNV-1a; seeds the PRNG from the entry id so every render is identical. */
const hashSeed = (seed: string): number => {
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** mulberry32: tiny, fast, good enough for jitter. */
const makeRandom = (seed: string): (() => number) => {
  let state = hashSeed(seed)
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const round = (value: number) => Math.round(value * 10) / 10

/** Smooth path through points (Catmull-Rom converted to cubic Béziers). */
const smoothPath = (points: ReadonlyArray<Point>): string => {
  if (points.length < 2) return ''
  const [first] = points
  let path = `M${round(first![0])} ${round(first![1])}`
  for (let index = 0; index < points.length - 1; index++) {
    const p0 = points[Math.max(0, index - 1)]!
    const p1 = points[index]!
    const p2 = points[index + 1]!
    const p3 = points[Math.min(points.length - 1, index + 2)]!
    const c1: Point = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2: Point = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    path += ` C${round(c1[0])} ${round(c1[1])} ${round(c2[0])} ${round(c2[1])} ${round(p2[0])} ${round(p2[1])}`
  }
  return path
}

const escapeXml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

const stroke = ({ d, color, width, opacity = 1 }: {
  d: string
  color: string
  width: number
  opacity?: number
}) =>
  `<path d="${d}" fill="none" stroke="${escapeXml(color)}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"${opacity === 1 ? '' : ` opacity="${opacity}"`}/>`

/** A loose ellipse that overshoots its start, like a pen circling something. */
const ellipseLoop = ({
  box,
  padding,
  random,
  wobble,
  turns,
}: {
  box: Box
  padding: number
  random: () => number
  wobble: number
  turns: number
}): { readonly points: ReadonlyArray<Point>; readonly rx: number; readonly ry: number } => {
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  // Optical: near-square targets get a circle; wide ones a flatter ellipse.
  const rx = box.width / 2 + padding
  const ry = box.height / 2 + padding
  const start = -Math.PI * (0.55 + random() * 0.2)
  const sweep = Math.PI * 2 * turns + 0.35 + random() * 0.25
  const phaseA = random() * Math.PI * 2
  const phaseB = random() * Math.PI * 2
  const steps = Math.max(18, Math.round(28 * turns))
  const points: Point[] = []
  for (let step = 0; step <= steps; step++) {
    const t = step / steps
    const angle = start + sweep * t
    // The radius drifts outwards over the stroke so the overlap does not retrace the start.
    const drift = 1 + 0.06 * t
    const jitter = 1 + wobble * (Math.sin(angle * 2 + phaseA) * 0.6 + Math.sin(angle * 3 + phaseB) * 0.4)
    points.push([cx + Math.cos(angle) * rx * drift * jitter, cy + Math.sin(angle) * ry * drift * jitter])
  }
  return { points, rx, ry }
}

const ring = ({
  annotation,
  box,
  theme,
  random,
}: {
  annotation: Extract<Annotation<string>, { kind: 'ring' }>
  box: Box
  theme: AnnotationTheme
  random: () => number
}): string => {
  const padding = annotation.padding ?? 8
  const { points, rx, ry } = ellipseLoop({ box, padding, random, wobble: 0.035, turns: 1 })
  // Badge sits on the upper-right of the ring.
  const angle = -Math.PI / 4
  const bx = box.x + box.width / 2 + Math.cos(angle) * rx
  const by = box.y + box.height / 2 + Math.sin(angle) * ry
  return [
    stroke({ d: smoothPath(points), color: theme.ink, width: 3.5 }),
    `<circle cx="${round(bx)}" cy="${round(by)}" r="12" fill="${escapeXml(theme.badgeFill)}" stroke="${escapeXml(theme.ink)}" stroke-width="1.5"/>`,
    `<text x="${round(bx)}" y="${round(by)}" text-anchor="middle" dominant-baseline="central" font-family="${escapeXml(theme.fontFamily)}" font-size="14" font-weight="700" fill="${escapeXml(theme.badgeInk)}">${annotation.n}</text>`,
  ].join('')
}

/** The point where the ray from the box centre towards `toward` leaves the box, plus a gap. */
const edgePoint = ({ box, toward, gap }: { box: Box; toward: Point; gap: number }): Point => {
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const dx = toward[0] - cx
  const dy = toward[1] - cy
  const length = Math.hypot(dx, dy) || 1
  const scale = Math.min(
    dx === 0 ? Number.POSITIVE_INFINITY : box.width / 2 / Math.abs(dx),
    dy === 0 ? Number.POSITIVE_INFINITY : box.height / 2 / Math.abs(dy),
  )
  return [cx + dx * scale + (dx / length) * gap, cy + dy * scale + (dy / length) * gap]
}

const arrow = ({
  annotation,
  box,
  theme,
  random,
}: {
  annotation: Extract<Annotation<string>, { kind: 'arrow' }>
  box: Box
  theme: AnnotationTheme
  random: () => number
}): string => {
  const start: Point = [
    box.x + box.width / 2 + annotation.from.dx,
    box.y + box.height / 2 + annotation.from.dy,
  ]
  const end = edgePoint({ box, toward: start, gap: 6 })
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  const length = Math.hypot(dx, dy) || 1
  const bend = (random() < 0.5 ? -1 : 1) * length * (0.14 + random() * 0.08)
  const control: Point = [
    (start[0] + end[0]) / 2 + (-dy / length) * bend,
    (start[1] + end[1]) / 2 + (dx / length) * bend,
  ]
  const shaft: Point[] = []
  for (let step = 0; step <= 10; step++) {
    const t = step / 10
    const u = 1 - t
    const wobble = Math.sin(t * Math.PI) * (random() - 0.5) * 1.6
    shaft.push([
      u * u * start[0] + 2 * u * t * control[0] + t * t * end[0] + wobble,
      u * u * start[1] + 2 * u * t * control[1] + t * t * end[1] + wobble,
    ])
  }
  const heading = Math.atan2(end[1] - control[1], end[0] - control[0])
  const head = (side: 1 | -1): string => {
    const spread = (0.45 + random() * 0.12) * side
    const size = 13 + random() * 3
    const tip: Point = [
      end[0] - Math.cos(heading + spread) * size,
      end[1] - Math.sin(heading + spread) * size,
    ]
    return `M${round(tip[0])} ${round(tip[1])} L${round(end[0])} ${round(end[1])}`
  }
  return [
    stroke({ d: smoothPath(shaft), color: theme.ink, width: 3 }),
    stroke({ d: `${head(1)} ${head(-1)}`, color: theme.ink, width: 3 }),
  ].join('')
}

const mark = ({
  annotation,
  box,
  theme,
  random,
}: {
  annotation: Extract<Annotation<string>, { kind: 'mark' }>
  box: Box
  theme: AnnotationTheme
  random: () => number
}): string => {
  if (annotation.style === 'scribble') {
    const { points } = ellipseLoop({ box, padding: 6, random, wobble: 0.08, turns: 2 })
    return stroke({ d: smoothPath(points), color: theme.ink, width: 2.5 })
  }
  const highlight = annotation.style === 'highlight'
  const y = highlight ? box.y + box.height * 0.55 : box.y + box.height + 5
  const from = box.x - 4
  const to = box.x + box.width + 4
  const steps = Math.max(3, Math.round((to - from) / 14))
  const points: Point[] = []
  for (let step = 0; step <= steps; step++) {
    const t = step / steps
    points.push([from + (to - from) * t, y + (random() - 0.5) * (highlight ? 2 : 3) + t * 1.5])
  }
  return highlight
    ? stroke({
        d: smoothPath(points),
        color: theme.highlight,
        width: Math.max(10, round(box.height * 0.7)),
        opacity: 0.45,
      })
    : stroke({ d: smoothPath(points), color: theme.ink, width: 3 })
}

const caption = ({
  annotation,
  box,
  theme,
}: {
  annotation: Extract<Annotation<string>, { kind: 'caption' }>
  box: Box
  theme: AnnotationTheme
}): string => {
  const gap = 12
  const [x, y, anchor, baseline] =
    annotation.side === 'top'
      ? [box.x + box.width / 2, box.y - gap, 'middle', 'auto']
      : annotation.side === 'bottom'
        ? [box.x + box.width / 2, box.y + box.height + gap, 'middle', 'hanging']
        : annotation.side === 'left'
          ? [box.x - gap, box.y + box.height / 2, 'end', 'central']
          : [box.x + box.width + gap, box.y + box.height / 2, 'start', 'central']
  return `<text x="${round(x)}" y="${round(y)}" text-anchor="${anchor}" dominant-baseline="${baseline}" font-family="${escapeXml(theme.fontFamily)}" font-size="15" font-weight="700" fill="${escapeXml(theme.captionInk)}" stroke="${escapeXml(theme.captionHalo)}" stroke-width="5" stroke-linejoin="round" paint-order="stroke">${escapeXml(annotation.text)}</text>`
}

/**
 * Draws placed annotations into one fixed, pointer-transparent SVG covering the viewport.
 * Rings and marks are drawn first so arrows and captions stay legible on top.
 */
export const drawAnnotations = ({
  placed,
  theme,
  seed,
  viewport,
}: {
  readonly placed: ReadonlyArray<PlacedAnnotation>
  readonly theme: AnnotationTheme
  /** Usually the entry id plus the scheme-independent viewport name. */
  readonly seed: string
  readonly viewport: { readonly width: number; readonly height: number }
}): string => {
  const random = makeRandom(seed)
  const order = { mark: 0, ring: 1, arrow: 2, caption: 3 } as const
  const body = placed
    .map((item, index) => ({ item, index }))
    .toSorted(
      (a, b) =>
        order[a.item.annotation.kind] - order[b.item.annotation.kind] || a.index - b.index,
    )
    .map(({ item: { annotation, box } }) => {
      switch (annotation.kind) {
        case 'ring':
          return ring({ annotation, box, theme, random })
        case 'arrow':
          return arrow({ annotation, box, theme, random })
        case 'mark':
          return mark({ annotation, box, theme, random })
        case 'caption':
          return caption({ annotation, box, theme })
      }
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" data-changelog-annotations="" width="${viewport.width}" height="${viewport.height}" viewBox="0 0 ${viewport.width} ${viewport.height}" style="position:fixed;inset:0;z-index:2147483647;pointer-events:none;overflow:visible">${body}</svg>`
}

/**
 * The crop rectangle: the base box (crop target grown by its padding, or an explicit rect)
 * clamped to the viewport and snapped outwards to whole pixels.
 */
export const cropRect = ({
  base,
  viewport,
}: {
  readonly base: Box
  readonly viewport: { readonly width: number; readonly height: number }
}): Box => {
  const x = Math.max(0, Math.floor(base.x))
  const y = Math.max(0, Math.floor(base.y))
  const right = Math.min(viewport.width, Math.ceil(base.x + base.width))
  const bottom = Math.min(viewport.height, Math.ceil(base.y + base.height))
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) }
}
