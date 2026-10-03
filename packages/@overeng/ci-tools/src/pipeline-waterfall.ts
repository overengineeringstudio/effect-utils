import type { PipelineRow } from './pipeline-report.ts'

/** Jobs API job/step spans for one run attempt; untimed jobs omit start/end rather than inventing zero. */
export type PipelineTimeline = {
  readonly attempt: number
  readonly jobs: readonly {
    readonly name: string
    readonly status: string
    readonly attempt: number
    readonly start?: number | undefined
    readonly end?: number | undefined
    readonly steps: readonly {
      readonly name: string
      readonly status: string
      readonly start: number
      readonly end: number
    }[]
  }[]
}

/** Only the approved public PNG host can appear in comment HTML. */
export const pipelineWaterfallImageUrl = (value: string): boolean =>
  /^https:\/\/gitbucket\.schickling\.dev\/api\/get\/[a-f0-9]{64}$/u.test(value) &&
  !/\s/u.test(value)

/** Error conclusions, the five slowest measured jobs, and material main-p50 regressions. */
export const compactPipelineRows = (rows: readonly PipelineRow[]): Set<PipelineRow> =>
  new Set([
    ...rows.filter(
      (row) => !['success', 'cancelled', 'skipped', 'neutral', 'unfinished'].includes(row.status),
    ),
    ...rows
      .filter((row) => row.wallTimeMs !== undefined)
      .toSorted((a, b) => b.wallTimeMs! - a.wallTimeMs!)
      .slice(0, 5),
    ...rows.filter(
      (row) =>
        row.deltaMs !== undefined &&
        row.baselineMs !== undefined &&
        row.baselineMs > 0 &&
        row.deltaMs >= 30_000 &&
        row.deltaMs / row.baselineMs >= 0.25,
    ),
  ])

const escapeXml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
const duration = (ms: number): string =>
  `${Math.floor(ms / 60_000)}m ${Math.floor(ms / 1000) % 60}s`

/** Baked theme palettes; no media-query dependency in the rasterizer. No DAG claims. */
export const renderPipelineWaterfall = ({
  timeline,
  theme,
}: {
  readonly timeline: PipelineTimeline
  readonly theme: 'light' | 'dark'
}): string => {
  const colors =
    theme === 'light'
      ? {
          bg: '#ffffff',
          fg: '#1f2328',
          muted: '#59636e',
          grid: '#d1d9e0',
          job: '#0969da',
          step: '#54aeff',
          failure: '#cf222e',
          unfinished: '#bf8700',
          cancelled: '#818b98',
        }
      : {
          bg: '#0d1117',
          fg: '#f0f6fc',
          muted: '#9198a1',
          grid: '#3d444d',
          job: '#4493f8',
          step: '#1f6feb',
          failure: '#f85149',
          unfinished: '#d29922',
          cancelled: '#818b98',
        }
  const slowest = timeline.jobs
    .filter((job) => job.start !== undefined && job.end !== undefined)
    .toSorted((a, b) => b.end! - b.start! - (a.end! - a.start!))[0]
  const allRows: {
    readonly kind: 'job' | 'step' | 'note'
    readonly status: string
    readonly start: number | undefined
    readonly end: number | undefined
    readonly label: string
    readonly badge: string
  }[] = []
  const chronological = timeline.jobs.toSorted(
    (a, b) => (a.start ?? Infinity) - (b.start ?? Infinity) || a.name.localeCompare(b.name),
  )
  for (const job of chronological) {
    const important = job.steps
      .filter((step) => step.status !== 'success')
      .toSorted((a, b) => a.start - b.start)
    const longest = job.steps
      .filter((step) => !important.includes(step))
      .toSorted((a, b) => b.end - b.start - (a.end - a.start))
    const chosen = new Set(important.concat(longest).slice(0, 4))
    const omitted = job.steps.length - chosen.size
    allRows.push({
      kind: 'job',
      status: job.status,
      start: job.start,
      end: job.end,
      label: `${job === slowest ? 'Slowest · ' : ''}${job.name} (${job.status})`,
      badge: `a${job.attempt}${job.attempt < timeline.attempt ? ' carried over' : ''}`,
    })
    for (const step of job.steps.toSorted((a, b) => a.start - b.start)) {
      if (chosen.has(step) === false) continue
      allRows.push({
        kind: 'step',
        status: step.status,
        start: step.start,
        end: step.end,
        label: `↳ ${step.name}`,
        badge: '',
      })
    }
    if (omitted > 0)
      allRows.push({
        kind: 'note',
        status: 'unavailable',
        start: undefined,
        end: undefined,
        label: `↳ ${omitted} other timed steps omitted`,
        badge: '',
      })
  }
  // Bound raster dimensions independently of the provider's job/step count.
  const rows = allRows.slice(0, 300)
  const spans = timeline.jobs
    .filter((job) => job.start !== undefined && job.end !== undefined && job.end >= job.start)
    .toSorted((a, b) => a.start! - b.start!)
  const segments: { from: number; to: number }[] = []
  for (const job of spans) {
    const last = segments.at(-1)
    if (last !== undefined && job.start! <= last.to + 300_000) last.to = Math.max(last.to, job.end!)
    else segments.push({ from: job.start!, to: Math.max(job.start! + 1000, job.end!) })
  }
  const origin = segments[0]?.from ?? 0
  const width = 960
  const plotStart = 320
  const breakWidth = Math.min(28, 200 / Math.max(1, segments.length - 1))
  const plotWidth = 420
  const total = segments.reduce((sum, segment) => sum + segment.to - segment.from, 0)
  const px = (plotWidth - breakWidth * Math.max(0, segments.length - 1)) / Math.max(1, total)
  const position = (time: number): number => {
    let x = plotStart
    for (const segment of segments) {
      if (time <= segment.to) return x + Math.max(0, time - segment.from) * px
      x += (segment.to - segment.from) * px + breakWidth
    }
    return plotStart + plotWidth
  }
  // Leave a separate band for axis labels below the multi-line header and legend.
  // 16px type remains >=12px at GitHub's 770px comment width; keep 20px rows.
  const top = 110
  const height = top + rows.length * 20 + 56
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" role="img" aria-label="Pipeline jobs and steps waterfall"><style>text{font-family:DejaVu Sans,sans-serif;font-size:16px;fill:${colors.fg}}.muted{fill:${colors.muted}}</style><defs><clipPath id="labels"><rect x="12" y="${top}" width="${plotStart - 24}" height="${rows.length * 20}"/></clipPath></defs><rect width="${width}" height="${height}" fill="${colors.bg}"/><text x="12" y="22">Pipeline jobs + steps · attempt ${timeline.attempt}</text><text class="muted" x="12" y="42">Chronological; up to four timed steps/job (non-success first, then longest). Dashed idle breaks.</text><text class="muted" x="12" y="60">Origin ${escapeXml(segments.length === 0 ? 'unavailable' : new Date(origin).toISOString())}</text><text class="muted" x="12" y="78">blue: success · red: failed/timed out/other error · amber: in progress · grey: cancelled/skipped/neutral</text>`,
  ]
  // Piecewise segments compress small spans and many idle gaps squeeze breaks together, so
  // every axis label and gap caption is placed left to right only where it does not collide.
  // Captions that cannot be placed are summarized at the left of the caption band instead.
  const labelWidth = 112
  const captionCharWidth = 9
  let labelEnd = -Infinity
  let captionEnd = plotStart
  const hiddenGaps: number[] = []
  for (const [index, segment] of segments.entries()) {
    const x = position(segment.from)
    const nextStart = index + 1 < segments.length ? position(segments[index + 1]!.from) : Infinity
    const startLabelled = x + 3 >= labelEnd
    if (startLabelled === true) labelEnd = x + 3 + labelWidth
    out.push(
      `<line x1="${x}" x2="${x}" y1="${top - 4}" y2="${height - 32}" stroke="${colors.grid}"/>${startLabelled === true ? `<text class="muted" x="${x + 3}" y="${top - 8}">T+${duration(segment.from - origin)}</text>` : ''}`,
    )
    if (index > 0) {
      const gap = segment.from - segments[index - 1]!.to
      const caption = `${duration(gap)} idle (compressed)`
      const captionX = x - breakWidth
      const captioned = captionX >= captionEnd
      if (captioned === true) captionEnd = captionX + caption.length * captionCharWidth
      else hiddenGaps.push(gap)
      out.push(
        `<rect x="${captionX}" y="${top}" width="${breakWidth}" height="${rows.length * 20}" fill="${colors.bg}" stroke="${colors.muted}" stroke-dasharray="3 3"><title>${duration(gap)} idle gap compressed</title></rect>${captioned === true ? `<text class="muted" x="${captionX}" y="${height - 24}">${caption}</text>` : ''}`,
      )
    }
    const step = Math.max(30_000, Math.ceil((segment.to - segment.from) / 4 / 30_000) * 30_000)
    for (let time = segment.from + step; time <= segment.to; time += step) {
      const tick = position(time)
      const labelled = tick + 2 >= labelEnd && tick + 2 + labelWidth <= nextStart
      if (labelled === true) labelEnd = tick + 2 + labelWidth
      out.push(
        `<line x1="${tick}" x2="${tick}" y1="${top}" y2="${height - 32}" stroke="${colors.grid}"/>${labelled === true ? `<text class="muted" x="${tick + 2}" y="${top - 8}">T+${duration(time - origin)}</text>` : ''}`,
      )
    }
  }
  if (hiddenGaps.length > 0)
    out.push(
      `<text class="muted" x="12" y="${height - 24}">${hiddenGaps.length} more idle gaps compressed, ${duration(hiddenGaps.reduce((sum, gap) => sum + gap, 0))} total</text>`,
    )
  for (const [index, row] of rows.entries()) {
    const y = top + index * 20
    const label = row.label.length > 32 ? `${row.label.slice(0, 31)}…` : row.label
    const badge =
      `${row.start === undefined || row.end === undefined ? '' : duration(row.end - row.start)} ${row.badge}`.trim()
    out.push(
      `<text x="${row.kind === 'job' ? 12 : 26}" y="${y + 15}" clip-path="url(#labels)"><title>${escapeXml(row.label)}</title>${escapeXml(label)}</text><text class="muted" x="948" y="${y + 15}" text-anchor="end">${escapeXml(badge)}</text>`,
    )
    if (row.start === undefined || row.end === undefined) {
      if (row.kind === 'note') continue
      out.push(
        `<text class="muted" x="${plotStart}" y="${y + 15}">timing unavailable (not zero)</text>`,
      )
      continue
    }
    const x = position(row.start)
    const color =
      row.status === 'unfinished'
        ? colors.unfinished
        : row.status === 'success'
          ? row.kind === 'job'
            ? colors.job
            : colors.step
          : row.status === 'cancelled' || row.status === 'skipped' || row.status === 'neutral'
            ? colors.cancelled
            : colors.failure
    out.push(
      `<rect x="${x}" y="${y + 4}" width="${Math.max(2, position(row.end) - x)}" height="${row.kind === 'job' ? 12 : 9}" rx="2" fill="${color}"><title>${escapeXml(row.label)}: ${duration(row.end - row.start)}</title></rect>`,
    )
  }
  if (allRows.length > rows.length)
    out.push(
      `<text class="muted" x="12" y="${height - 4}">${allRows.length - rows.length} additional timeline rows omitted; full jobs table retained.</text>`,
    )
  out.push('</svg>')
  return out.join('')
}
