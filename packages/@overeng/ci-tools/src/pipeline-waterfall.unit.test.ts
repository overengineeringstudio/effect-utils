import { describe, expect, it } from 'vitest'

import type { PipelineRow } from './pipeline-report.ts'
import {
  compactPipelineRows,
  pipelineWaterfallImageUrl,
  renderPipelineWaterfall,
  type PipelineTimeline,
} from './pipeline-waterfall.ts'

const row = (job: string, wallTimeMs?: number): PipelineRow => ({
  job,
  status: 'success',
  wallTime: wallTimeMs === undefined ? 'unavailable' : `${wallTimeMs / 1000}s`,
  delta: 'no main baseline',
  instrumented: false,
  ...(wallTimeMs === undefined ? {} : { wallTimeMs }),
})

const bars = (svg: string) =>
  new Map(
    [
      ...svg.matchAll(
        /<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)"[^>]*fill="([^"]+)"[^>]*><title>([^<]+)<\/title>/gu,
      ),
    ].map(
      (match) =>
        [match[4]!, { x: Number(match[1]), width: Number(match[2]), fill: match[3]! }] as const,
    ),
  )

const timeline: PipelineTimeline = {
  attempt: 2,
  jobs: [
    {
      name: 'Build',
      status: 'success',
      attempt: 1,
      start: 0,
      end: 120_000,
      steps: [
        { name: 'Compile', status: 'success', start: 30_000, end: 90_000 },
        { name: 'Failed checks', status: 'failure', start: 90_000, end: 120_000 },
        { name: 'Cancelled cleanup', status: 'cancelled', start: 90_000, end: 120_000 },
        { name: 'Running export', status: 'unfinished', start: 90_000, end: 120_000 },
      ],
    },
  ],
}

describe('compact pipeline row selection', () => {
  const slowest = Array.from({ length: 5 }, (_, index) => row(`slow-${index}`, 900_000 - index))

  it('selects the five slowest measured jobs regardless of input order, plus unmeasured failures', () => {
    const failure = { ...row('failure'), status: 'timed_out' }
    const ordinary = row('ordinary', 10_000)
    const unmeasured = row('unmeasured')
    const selected = compactPipelineRows([ordinary, failure, ...slowest.toReversed(), unmeasured])
    expect([...selected].map((item) => item.job).toSorted()).toEqual(
      [...slowest.map((item) => item.job), 'failure'].toSorted(),
    )
    expect(selected.has(ordinary)).toBe(false)
    expect(selected.has(unmeasured)).toBe(false)
  })

  it('requires both a thirty-second and twenty-five-percent regression against a positive baseline', () => {
    const boundary = { ...row('boundary', 150_000), deltaMs: 30_000, baselineMs: 120_000 }
    const smallAbsolute = { ...row('small-absolute', 100_000), deltaMs: 29_999, baselineMs: 60_000 }
    const smallRelative = {
      ...row('small-relative', 150_001),
      deltaMs: 30_000,
      baselineMs: 120_001,
    }
    const faster = { ...row('faster', 90_000), deltaMs: -30_000, baselineMs: 120_000 }
    const zeroBaseline = { ...row('zero-baseline', 100_000), deltaMs: 100_000, baselineMs: 0 }
    const unknownBaseline = { ...row('unknown-baseline', 100_000), deltaMs: 100_000 }
    const selected = compactPipelineRows([
      ...slowest,
      boundary,
      smallAbsolute,
      smallRelative,
      faster,
      zeroBaseline,
      unknownBaseline,
    ])
    expect(selected.has(boundary)).toBe(true)
    for (const excluded of [smallAbsolute, smallRelative, faster, zeroBaseline, unknownBaseline]) {
      expect(selected.has(excluded)).toBe(false)
    }
  })
})

describe('public waterfall image boundary', () => {
  it('accepts approved HTTPS PNGs and rejects other hosts, schemes and HTML attribute injection', () => {
    expect(
      pipelineWaterfallImageUrl(
        'https://gitbucket.schickling.dev/api/get/8d0b18017feaf616a88587f00aa25619336291a00cd9e27f32a243b4dd9ff4fd',
      ),
    ).toBe(true)
    for (const unsafe of [
      'http://gitbucket.schickling.dev/ci/light.png',
      'https://example.test/ci/light.png',
      'https://gitbucket.schickling.dev.evil.test/light.png',
      'https://gitbucket.schickling.dev@evil.test/light.png',
      'javascript:alert(1)',
      'data:image/png;base64,abc',
      'https://gitbucket.schickling.dev/light.svg',
      'https://gitbucket.schickling.dev/light.png" onerror="alert(1)',
      'https://gitbucket.schickling.dev/light image.png',
      'https://gitbucket.schickling.dev/light.png\n',
      `https://gitbucket.schickling.dev/api/get/${'a'.repeat(63)}`,
      `https://gitbucket.schickling.dev/api/get/${'A'.repeat(64)}`,
      `https://gitbucket.schickling.dev/api/get/${'a'.repeat(64)}?download=1`,
      `https://gitbucket.schickling.dev/api/get/${'a'.repeat(64)}\n`,
    ]) {
      expect(pipelineWaterfallImageUrl(unsafe)).toBe(false)
    }
  })
})

describe('pipeline jobs and steps waterfall', () => {
  it('positions step timings within their job and distinguishes failure, cancellation and unfinished status in both themes', () => {
    for (const theme of ['light', 'dark'] as const) {
      const svg = renderPipelineWaterfall({ timeline: timeline, theme: theme })
      const rectangles = bars(svg)
      const job = rectangles.get('Slowest · Build (success): 2m 0s')!
      const compile = rectangles.get('↳ Compile: 1m 0s')!
      expect(compile.width).toBeCloseTo(job.width / 2)
      expect(compile.x).toBeCloseTo(job.x + job.width / 4)
      const statusColors = [
        compile.fill,
        rectangles.get('↳ Failed checks: 0m 30s')!.fill,
        rectangles.get('↳ Cancelled cleanup: 0m 30s')!.fill,
        rectangles.get('↳ Running export: 0m 30s')!.fill,
      ]
      expect(new Set(statusColors).size).toBe(4)
      expect(svg).toContain('a1 carried over')
      expect(svg).toContain('1970-01-01T00:00:00.000Z')
      expect(svg.replaceAll(/<title>[^<]*<\/title>/gu, '')).toContain(
        '>2m 0s a1 carried over</text>',
      )
      expect(svg.replaceAll(/<title>[^<]*<\/title>/gu, '')).toContain('>1m 0s</text>')
    }
  })

  it('never paints timed-out, action-required or unknown conclusions as success', () => {
    const svg = renderPipelineWaterfall({
      timeline: {
        attempt: 1,
        jobs: [
          'success',
          'failure',
          'timed_out',
          'action_required',
          'startup_failure',
          'skipped',
          'neutral',
        ].map((status, index) => ({
          name: status,
          status,
          attempt: 1,
          start: index * 1000,
          end: (index + 1) * 1000,
          steps: [],
        })),
      },
      theme: 'light',
    })
    const fill = (status: string) =>
      [...bars(svg)].find(([title]) => title.includes(`${status} (${status})`))![1].fill
    for (const status of ['timed_out', 'action_required', 'startup_failure']) {
      expect(fill(status)).toBe(fill('failure'))
      expect(fill(status)).not.toBe(fill('success'))
    }
    expect(fill('neutral')).toBe(fill('skipped'))
    expect(fill('neutral')).not.toBe(fill('success'))
  })

  it('bakes different light and dark palettes without relying on rasterizer media queries', () => {
    const light = renderPipelineWaterfall({ timeline: timeline, theme: 'light' })
    const dark = renderPipelineWaterfall({ timeline: timeline, theme: 'dark' })
    expect(bars(light).get('Slowest · Build (success): 2m 0s')?.fill).not.toBe(
      bars(dark).get('Slowest · Build (success): 2m 0s')?.fill,
    )
    for (const svg of [light, dark]) {
      expect(svg).not.toContain('@media')
      expect(svg).toContain('role="img"')
      expect(svg).toContain('aria-label="Pipeline jobs and steps waterfall"')
    }
  })

  it('confines wide labels to the label column while retaining their full names in tooltips', () => {
    const name = 'W'.repeat(80)
    for (const theme of ['light', 'dark'] as const) {
      const svg = renderPipelineWaterfall({
        timeline: {
          attempt: 1,
          jobs: [{ name, status: 'success', attempt: 1, start: 0, end: 1000, steps: [] }],
        },
        theme,
      })
      const clip = svg.match(
        /<clipPath id="([^"]+)"><rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/u,
      )!
      const label = svg.match(
        /<text x="[\d.]+" y="[\d.]+" clip-path="url\(#([^"]+)\)"><title>([^<]+)<\/title>([^<]+)<\/text>/u,
      )!
      expect(label[1]).toBe(clip[1])
      expect(label[2]).toContain(name)
      expect(label[3]).not.toContain(name)
      const job = [...bars(svg).values()][0]!
      expect(Number(clip[2]) + Number(clip[3])).toBeLessThan(job.x)
    }
  })

  it('escapes job and step labels in visible text and tooltips', () => {
    const svg = renderPipelineWaterfall({
      timeline: {
        attempt: 1,
        jobs: [
          {
            name: '<script>&"\'job',
            status: 'success',
            attempt: 1,
            start: 0,
            end: 1000,
            steps: [{ name: '<image onload="x">&\'step', status: 'success', start: 0, end: 1000 }],
          },
        ],
      },
      theme: 'light',
    })
    expect(svg).toContain('&lt;script&gt;&amp;&quot;&apos;job')
    expect(svg).toContain('&lt;image onload=&quot;x&quot;&gt;&amp;&apos;step')
    expect(svg).not.toContain('<script>')
    expect(svg).not.toContain('<image onload=')
  })

  it('orders carried-over and rerun jobs chronologically and explicitly marks compressed idle gaps', () => {
    const svg = renderPipelineWaterfall({
      timeline: {
        attempt: 2,
        jobs: [
          {
            name: 'Rerun',
            status: 'success',
            attempt: 2,
            start: 3_600_000,
            end: 3_720_000,
            steps: [],
          },
          { name: 'Earlier', status: 'success', attempt: 1, start: 0, end: 60_000, steps: [] },
        ],
      },
      theme: 'dark',
    })
    expect(svg.indexOf('<title>Earlier (success)</title>')).toBeLessThan(
      svg.indexOf('<title>Slowest · Rerun (success)</title>'),
    )
    expect(svg).toContain('59m 0s idle gap compressed')
    expect(svg).toContain('59m 0s idle (compressed)')
    expect(svg).toContain('T+60m 0s')
    const rectangles = bars(svg)
    const earlier = rectangles.get('Earlier (success): 1m 0s')!
    const rerun = rectangles.get('Slowest · Rerun (success): 2m 0s')!
    expect(rerun.width).toBeCloseTo(earlier.width * 2)
    expect(rerun.x - earlier.x - earlier.width).toBeLessThan(earlier.width)
  })

  it('never overlaps axis labels or idle-gap captions across many gaps and still accounts for every gap', () => {
    const svg = renderPipelineWaterfall({
      timeline: {
        attempt: 1,
        jobs: Array.from({ length: 12 }, (_, index) => ({
          name: `Job ${index}`,
          status: 'success',
          attempt: 1,
          start: index * 3_600_000,
          end: index * 3_600_000 + 60_000,
          steps: [],
        })),
      },
      theme: 'light',
    })
    const texts = [
      ...svg.matchAll(/<text class="muted" x="([\d.]+)" y="([\d.]+)">([^<]+)<\/text>/gu),
    ]
    const axis = texts.filter((match) => match[3]!.startsWith('T+'))
    const captions = texts.filter((match) => match[3]!.endsWith('idle (compressed)'))
    expect(axis.length).toBeGreaterThan(1)
    expect(captions.length).toBeGreaterThan(0)
    for (const group of [axis, captions]) {
      for (let index = 1; index < group.length; index++) {
        const previous = group[index - 1]!
        // Reserve enough space for the larger axis and caption glyphs.
        const reserved = previous[3]!.startsWith('T+') === true ? 112 : previous[3]!.length * 9
        expect(Number(group[index]![1])).toBeGreaterThanOrEqual(Number(previous[1]) + reserved)
      }
    }
    const summary = texts.find((match) => match[3]!.includes('more idle gaps compressed'))!
    for (const caption of captions) {
      expect(Math.abs(Number(caption[2]) - Number(summary[2]))).toBeGreaterThanOrEqual(16)
      expect(Number(caption[1]) + caption[3]!.length * 9).toBeLessThanOrEqual(960)
    }
    const hidden = svg.match(/>(\d+) more idle gaps compressed, (\d+)m 0s total</u)
    expect(hidden).not.toBeNull()
    expect(Number(hidden![1]) + captions.length).toBe(11)
    expect(Number(hidden![2])).toBe(Number(hidden![1]) * 59)
  })

  it('keeps skipped and untimed jobs visible without inventing zero-duration bars', () => {
    const svg = renderPipelineWaterfall({
      timeline: {
        attempt: 1,
        jobs: [
          { name: 'Skipped', status: 'skipped', attempt: 1, steps: [] },
          { name: 'Invalid time', status: 'success', attempt: 1, steps: [] },
        ],
      },
      theme: 'light',
    })
    expect(svg).toContain('Skipped (skipped)')
    expect(svg).toContain('Invalid time (success)')
    expect(svg).toContain('timing unavailable (not zero)')
    expect(svg).toContain('Origin unavailable')
    expect(bars(svg).size).toBe(0)
    expect(svg).not.toMatch(/NaN|Infinity/u)
  })

  it('keeps four useful steps per job, retaining non-successes before the longest successful steps', () => {
    const svg = renderPipelineWaterfall({
      timeline: {
        attempt: 1,
        jobs: [
          {
            name: 'Useful steps',
            status: 'failure',
            attempt: 1,
            start: 0,
            end: 600_000,
            steps: [
              { name: 'Short setup', status: 'success', start: 0, end: 1000 },
              { name: 'Long build', status: 'success', start: 1000, end: 201_000 },
              { name: 'Medium tests', status: 'success', start: 201_000, end: 321_000 },
              { name: 'Smaller task', status: 'success', start: 321_000, end: 421_000 },
              { name: 'Failed check', status: 'failure', start: 421_000, end: 422_000 },
              { name: 'Cleanup', status: 'success', start: 422_000, end: 482_000 },
              { name: 'Export', status: 'success', start: 482_000, end: 512_000 },
              { name: 'Still running', status: 'unfinished', start: 599_000, end: 600_000 },
            ],
          },
        ],
      },
      theme: 'light',
    })
    for (const name of ['Long build', 'Medium tests', 'Failed check', 'Still running']) {
      expect(svg).toContain(`<title>↳ ${name}</title>`)
    }
    for (const name of ['Short setup', 'Smaller task', 'Cleanup', 'Export']) {
      expect(svg).not.toContain(`<title>↳ ${name}</title>`)
    }
    expect(svg).toContain('4 other timed steps omitted')
    expect(bars(svg).size).toBe(5)
    const visible = svg.replaceAll(/<title>[^<]*<\/title>/gu, '')
    expect(visible).toContain('Slowest · Useful steps (failure)')
    expect(visible).toContain('>3m 20s</text>')
  })

  it('bounds unusually large job lists and discloses omitted timeline rows', () => {
    const svg = renderPipelineWaterfall({
      timeline: {
        attempt: 1,
        jobs: Array.from({ length: 301 }, (_, index) => ({
          name: `Job ${index}`,
          status: 'success',
          attempt: 1,
          start: index * 1000,
          end: (index + 1) * 1000,
          steps: [],
        })),
      },
      theme: 'light',
    })
    expect(svg).toContain('<title>Job 299 (success)</title>')
    expect(svg).not.toContain('<title>Job 300 (success)</title>')
    expect(svg).toContain('1 additional timeline rows omitted')
    expect(svg).toContain('full jobs table retained')
  })
})
